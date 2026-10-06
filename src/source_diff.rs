//! Bounded, deterministic line diff for the agent-facing source hunks.
use serde::Serialize;

#[derive(Serialize)]
pub struct SourceHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<String>,
}

const MAX_EDIT_DISTANCE: usize = 4000;
const MAX_HUNK_LINES: usize = 400;

fn lines(text: &str) -> Vec<&str> {
    text.split_terminator('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn diagonal(v: &[isize], d: usize, k: isize) -> isize {
    v[(k + d as isize) as usize]
}

/// Myers' shortest edit script. The trace holds only reachable diagonals.
fn myers<'a>(a: &[&'a str], b: &[&'a str]) -> Option<Vec<(char, &'a str)>> {
    let limit = (a.len() + b.len()).min(MAX_EDIT_DISTANCE);
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    for d in 0..=limit {
        let mut row = vec![0; 2 * d + 1];
        for k in (-(d as isize)..=d as isize).step_by(2) {
            let mut x = if d == 0 {
                0
            } else if k == -(d as isize)
                || (k != d as isize
                    && diagonal(&trace[d - 1], d - 1, k - 1)
                        < diagonal(&trace[d - 1], d - 1, k + 1))
            {
                diagonal(&trace[d - 1], d - 1, k + 1)
            } else {
                diagonal(&trace[d - 1], d - 1, k - 1) + 1
            };
            let mut y = x - k;
            while x < a.len() as isize && y < b.len() as isize && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            row[(k + d as isize) as usize] = x;
            if x == a.len() as isize && y == b.len() as isize {
                found = Some(d);
                break;
            }
        }
        trace.push(row);
        if found.is_some() {
            break;
        }
    }
    let distance = found?;
    let (mut x, mut y) = (a.len(), b.len());
    let mut rev = Vec::with_capacity(a.len() + b.len());
    for d in (1..=distance).rev() {
        let k = x as isize - y as isize;
        let prev = &trace[d - 1];
        let down = k == -(d as isize)
            || (k != d as isize && diagonal(prev, d - 1, k - 1) < diagonal(prev, d - 1, k + 1));
        let prev_k = if down { k + 1 } else { k - 1 };
        let prev_x = diagonal(prev, d - 1, prev_k) as usize;
        let prev_y = (prev_x as isize - prev_k) as usize;
        let snake_x = if down { prev_x } else { prev_x + 1 };
        let snake_y = if down { prev_y + 1 } else { prev_y };
        while x > snake_x && y > snake_y {
            x -= 1;
            y -= 1;
            rev.push((' ', a[x]));
        }
        if down {
            y -= 1;
            rev.push(('+', b[y]));
        } else {
            x -= 1;
            rev.push(('-', a[x]));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        rev.push((' ', a[x]));
    }
    rev.reverse();
    Some(rev)
}

fn fallback<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(char, &'a str)> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    a[..prefix]
        .iter()
        .map(|s| (' ', *s))
        .chain(a[prefix..a.len() - suffix].iter().map(|s| ('-', *s)))
        .chain(b[prefix..b.len() - suffix].iter().map(|s| ('+', *s)))
        .chain(a[a.len() - suffix..].iter().map(|s| (' ', *s)))
        .collect()
}

fn pair_changes(ops: Vec<(char, &str)>) -> Vec<(char, &str)> {
    let mut paired = Vec::with_capacity(ops.len());
    let mut i = 0;
    while i < ops.len() {
        if ops[i].0 == ' ' {
            paired.push(ops[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < ops.len() && ops[i].0 != ' ' {
            i += 1;
        }
        let removes: Vec<_> = ops[start..i]
            .iter()
            .copied()
            .filter(|(op, _)| *op == '-')
            .collect();
        let adds: Vec<_> = ops[start..i]
            .iter()
            .copied()
            .filter(|(op, _)| *op == '+')
            .collect();
        for k in 0..removes.len().max(adds.len()) {
            if let Some(op) = removes.get(k) {
                paired.push(*op);
            }
            if let Some(op) = adds.get(k) {
                paired.push(*op);
            }
        }
    }
    paired
}

pub fn hunks(old: &str, new: &str) -> (Vec<SourceHunk>, bool) {
    let a = lines(old);
    let b = lines(new);
    let mut ops = pair_changes(myers(&a, &b).unwrap_or_else(|| fallback(&a, &b)));
    // A terminator-only change needs an explicit replacement of the final line.
    if old.ends_with('\n') != new.ends_with('\n') && ops.last().is_some_and(|(op, _)| *op == ' ') {
        if let Some((_, last)) = ops.pop() {
            ops.push(('-', last));
            ops.push(('+', last));
        }
    }
    let changes: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(i, (op, _))| (*op != ' ').then_some(i))
        .collect();
    if changes.is_empty() {
        return (Vec::new(), false);
    }
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for idx in changes {
        let start = idx.saturating_sub(1);
        let end = (idx + 2).min(ops.len());
        if let Some(last) = ranges.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }
    let old_last = ops.iter().rposition(|(op, _)| *op != '+');
    let new_last = ops.iter().rposition(|(op, _)| *op != '-');
    let mut result = Vec::new();
    let mut budget = MAX_HUNK_LINES;
    let mut truncated = false;
    for (start, end) in ranges {
        if budget == 0 {
            truncated = true;
            break;
        }
        let old_before = ops[..start].iter().filter(|(op, _)| *op != '+').count();
        let new_before = ops[..start].iter().filter(|(op, _)| *op != '-').count();
        let mut all_lines = Vec::new();
        for (idx, (op, content)) in ops.iter().enumerate().take(end).skip(start) {
            all_lines.push((*op, format!("{op}{content}")));
            if (Some(idx) == old_last && *op == '-' && !old.ends_with('\n'))
                || (Some(idx) == new_last && *op == '+' && !new.ends_with('\n'))
            {
                all_lines.push(('\\', "\\ No newline at end of file".into()));
            }
        }
        let take = all_lines.len().min(budget);
        let selected = &all_lines[..take];
        let old_lines = selected
            .iter()
            .filter(|(op, _)| *op != '+' && *op != '\\')
            .count();
        let new_lines = selected
            .iter()
            .filter(|(op, _)| *op != '-' && *op != '\\')
            .count();
        result.push(SourceHunk {
            old_start: if a.is_empty() { 0 } else { old_before + 1 },
            old_lines,
            new_start: if b.is_empty() { 0 } else { new_before + 1 },
            new_lines,
            lines: selected.iter().map(|(_, line)| line.clone()).collect(),
        });
        budget -= take;
        if take < all_lines.len() {
            truncated = true;
            break;
        }
    }
    (result, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mmx008_d_large_file_fallback_keeps_change_visible() {
        let old = (0..2100).map(|i| format!("line {i}\n")).collect::<String>();
        let new = old.replace("line 1050", "changed 1050");
        let (h, truncated) = hunks(&old, &new);
        assert!(!truncated);
        assert_eq!(h[0].old_start, 1050);
        assert_eq!(
            h[0].lines,
            vec![" line 1049", "-line 1050", "+changed 1050", " line 1051"]
        );
    }
    #[test]
    fn mmx008_d_final_newline_change_is_visible() {
        let (h, truncated) = hunks("one", "one\n");
        assert!(!truncated);
        assert_eq!(
            h[0].lines,
            vec!["-one", "\\ No newline at end of file", "+one"]
        );
    }
    #[test]
    fn mmx008_d_distant_edits_in_20k_lines_reconstruct_new_text() {
        let old = (0..20_000)
            .map(|i| format!("line {i}\n"))
            .collect::<String>();
        let new = old
            .replace("line 10\n", "edited 10\n")
            .replace("line 19000\n", "edited 19000\n");
        let (hunks, truncated) = hunks(&old, &new);
        assert!(!truncated);
        assert_eq!(hunks.len(), 2);
        assert!(hunks[1].lines.contains(&"+edited 19000".to_string()));
        let mut rebuilt: Vec<String> = lines(&old).into_iter().map(str::to_string).collect();
        for h in hunks.iter().rev() {
            let replacement = h
                .lines
                .iter()
                .filter(|line| line.starts_with(' ') || line.starts_with('+'))
                .map(|line| line[1..].to_string())
                .collect::<Vec<_>>();
            rebuilt.splice(h.old_start - 1..h.old_start - 1 + h.old_lines, replacement);
        }
        assert_eq!(rebuilt.join("\n") + "\n", new);
    }

    #[test]
    fn mmx008_d_truncated_hunk_counts_match_included_lines() {
        let old = (0..450).map(|i| format!("old {i}\n")).collect::<String>();
        let new = old.replace("old", "new");
        let (hunks, truncated) = hunks(&old, &new);
        assert!(truncated);
        assert_eq!(hunks.iter().map(|h| h.lines.len()).sum::<usize>(), 400);
        for h in &hunks {
            assert_eq!(
                h.old_lines,
                h.lines
                    .iter()
                    .filter(|line| line.starts_with(' ') || line.starts_with('-'))
                    .count()
            );
            assert_eq!(
                h.new_lines,
                h.lines
                    .iter()
                    .filter(|line| line.starts_with(' ') || line.starts_with('+'))
                    .count()
            );
        }
    }

    #[test]
    fn mmx008_d_truncation_keeps_fitting_hunks_whole() {
        let old = (0..1000).map(|i| format!("line {i}\n")).collect::<String>();
        let mut new = old.clone();
        for i in 10..207 {
            new = new.replace(&format!("line {i}\n"), &format!("changed {i}\n"));
        }
        for i in 800..810 {
            new = new.replace(&format!("line {i}\n"), &format!("changed {i}\n"));
        }
        let (hunks, truncated) = hunks(&old, &new);
        assert!(truncated);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].lines.len(), 396);
        assert_eq!(hunks[0].old_lines, 199);
        assert_eq!(hunks[0].new_lines, 199);
        assert_eq!(hunks[1].lines.len(), 4);
        assert_eq!(hunks[1].old_lines, 3);
        assert_eq!(hunks[1].new_lines, 2);
    }

    #[test]
    fn mmx008_d_content_and_final_newline_change_has_marker() {
        let (h, _) = hunks("one\ntwo", "ONE\ntwo\n");
        assert!(h
            .iter()
            .flat_map(|h| &h.lines)
            .any(|line| line == "\\ No newline at end of file"));
        let (h, _) = hunks("one", "two\n");
        assert_eq!(
            h[0].lines,
            vec!["-one", "\\ No newline at end of file", "+two"]
        );
    }

    #[test]
    fn mmx008_d_crlf_hunks_strip_carriage_returns() {
        let (h, _) = hunks("one\r\ntwo\r\n", "one\ntwo changed\n");
        assert!(h
            .iter()
            .flat_map(|h| &h.lines)
            .all(|line| !line.contains('\r')));
        let (h, _) = hunks("one\r\ntwo\r\n", "one\ntwo\n");
        assert!(h.is_empty());
    }

    #[test]
    fn mmx008_d_empty_side_uses_zero_start() {
        let (h, _) = hunks("", "one\n");
        assert_eq!((h[0].old_start, h[0].old_lines), (0, 0));
        let (h, _) = hunks("one\n", "");
        assert_eq!((h[0].new_start, h[0].new_lines), (0, 0));
    }
}
