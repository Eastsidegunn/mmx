//! Conservative checks for cases mmdr currently accepts without a useful error.
use crate::{model::GraphModel, render::TurnError};

const HEADERS: &[&str] = &[
    "flowchart",
    "graph",
    "sequencediagram",
    "classdiagram",
    "statediagram",
    "erdiagram",
    "gantt",
    "pie",
    "journey",
    "gitgraph",
    "mindmap",
    "timeline",
    "quadrantchart",
    "requirementdiagram",
    "c4",
    "c4context",
    "c4container",
    "c4component",
    "c4dynamic",
    "c4deployment",
    "sankey",
    "zenuml",
    "block",
    "packet",
    "kanban",
    "architecture",
    "radar",
    "treemap",
    "xychart",
];

fn header(line: &str) -> Option<&'static str> {
    let lower = line.to_ascii_lowercase();
    HEADERS.iter().copied().find(|h| {
        lower.strip_prefix(h).is_some_and(|rest| {
            rest.chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric())
        })
    })
}

fn error(message: String, line: usize, column: usize) -> TurnError {
    TurnError {
        kind: "parse",
        message,
        line: Some(line as u32),
        column: Some(column as u32),
        candidates: None,
    }
}

pub fn check(source: &str) -> Result<(), TurnError> {
    let mut front = false;
    let mut first_nonblank_seen = false;
    let mut first = None;
    for (i, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if !first_nonblank_seen {
            first_nonblank_seen = true;
            if t == "---" {
                front = true;
                continue;
            }
        }
        if front {
            if t == "---" {
                front = false;
            }
            continue;
        }
        if t.starts_with("%%") {
            continue;
        }
        first = Some((i + 1, t));
        break;
    }
    let (header_line, first_text) = first.unwrap_or((1, ""));
    let kind = header(first_text).ok_or_else(|| {
        error(
            "missing diagram header (expected e.g. \"flowchart TD\")".into(),
            header_line,
            1,
        )
    })?;
    if kind != "flowchart" && kind != "graph" {
        return Ok(());
    }
    for (i, line) in source.lines().enumerate().skip(header_line) {
        let t = line.trim_start();
        if t.is_empty() || t.starts_with("%%") {
            continue;
        }
        if [
            "classDef",
            "class ",
            "style ",
            "linkStyle",
            "click ",
            "subgraph ",
            "direction ",
            "accTitle",
            "accDescr",
        ]
        .iter()
        .any(|p| t.starts_with(p))
        {
            continue;
        }
        let mut stack: Vec<(char, usize)> = Vec::new();
        let chars: Vec<char> = line.chars().collect();
        let (mut quoted, mut piped, mut escaped) = (false, false, false);
        // Code characters only (quoted text, |labels| and a trailing %%
        // comment blanked out), for the dangling-arrow check below.
        let mut code: Vec<char> = Vec::with_capacity(chars.len());
        for (col, &ch) in chars.iter().enumerate() {
            if ch == '|' && !quoted {
                code.push('|');
            } else if quoted || piped {
                code.push(' ');
            } else if ch == '%' && chars.get(col + 1) == Some(&'%') {
            } else {
                code.push(ch);
            }
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && quoted {
                escaped = true;
                continue;
            }
            if ch == '"' && !piped {
                quoted = !quoted;
                continue;
            }
            if quoted {
                continue;
            }
            if ch == '%' && chars.get(col + 1) == Some(&'%') {
                break;
            }
            if ch == '|' {
                piped = !piped;
                continue;
            }
            if piped {
                continue;
            }
            match ch {
                '(' | '[' | '{' => stack.push((ch, col + 1)),
                '>' if stack.is_empty()
                    && col > 0
                    && chars[col - 1].is_ascii_alphanumeric()
                    && chars
                        .get(col + 1)
                        .is_some_and(|c| !c.is_whitespace() && *c != '>') =>
                {
                    stack.push(('>', col + 1))
                }
                ')' | ']' | '}' => {
                    let expected = match ch {
                        ')' => '(',
                        ']' => '[',
                        _ => '{',
                    };
                    if stack
                        .last()
                        .is_some_and(|(open, _)| *open == expected || (*open == '>' && ch == ']'))
                    {
                        stack.pop();
                    }
                }
                _ => {}
            }
        }
        if let Some((open, col)) = stack.last() {
            return Err(error(
                format!("unclosed '{open}' opened at line {}, column {col}", i + 1),
                i + 1,
                *col,
            ));
        }
        if let Some(col) = dangling_arrow(&code) {
            return Err(error(
                format!("edge has no target node (line {}, column {col})", i + 1),
                i + 1,
                col,
            ));
        }
    }
    Ok(())
}

/// 1-based column of an arrow that ends the statement with nothing after it
/// (`A -->`, `A -- text -->`, `A -->|label|`). mmdr reports these at line 1,
/// column 1 with an unhelpful message.
fn dangling_arrow(code: &[char]) -> Option<usize> {
    let mut end = code.len();
    while end > 0 && code[end - 1].is_whitespace() {
        end -= 1;
    }
    // A blanked-out |label| at the end belongs to the arrow before it.
    if end > 0 && code[end - 1] == '|' {
        let open = code[..end - 1].iter().rposition(|&c| c == '|')?;
        end = open;
        while end > 0 && code[end - 1].is_whitespace() {
            end -= 1;
        }
    }
    let mut start = end;
    while start > 0 && "-=.~<>ox".contains(code[start - 1]) {
        start -= 1;
    }
    // A leading o/x glued to a word is the tail of a node id (`box-->`);
    // after whitespace it is an arrow marker (`A o--`).
    while start < end
        && "ox".contains(code[start])
        && start > 0
        && code[start - 1].is_alphanumeric()
    {
        start += 1;
    }
    let run = &code[start..end];
    let strokes = run.iter().filter(|c| "-=~".contains(**c)).count();
    (run.len() >= 3 && strokes >= 2).then_some(start + 1)
}

#[cfg(test)]
mod dangling_tests {
    use super::check;

    #[test]
    fn mmx008_d_dangling_arrow_is_located() {
        for (src, line, col) in [
            ("flowchart TD\n    A --> B\n    A -->\n", 3, 7),
            ("flowchart TD\n    A-->\n", 2, 6),
            ("flowchart TD\n    A -- text -->\n", 2, 15),
            ("flowchart TD\n    A -.->|later|\n", 2, 7),
            ("flowchart TD\n    A ==> %% todo\n", 2, 7),
            ("flowchart TD\n    A o--\n", 2, 7),
        ] {
            let err = check(src).expect_err(src);
            assert_eq!((err.line, err.column), (Some(line), Some(col)), "{src}");
            assert!(err.message.contains("no target"), "{}", err.message);
        }
    }

    #[test]
    fn mmx008_d_complete_edges_are_not_dangling() {
        for src in [
            "flowchart TD\n    A --> B\n",
            "flowchart TD\n    A --> box\n",
            "flowchart TD\n    A --o B\n    B --x C\n",
            "flowchart TD\n    A[\"ends with -->\"] --> B\n",
            "flowchart TD\n    A -->|a --> b| B\n",
            "flowchart TD\n    A --> B %% then -->\n",
            "flowchart TD\n    A ~~~ B\n",
            "flowchart TD\n    A[x] --> B[y]\n",
        ] {
            assert!(check(src).is_ok(), "{src}");
        }
    }
}

pub fn warnings(model: &GraphModel, baseline: bool, out: &mut Vec<String>) {
    if model.kind != "Flowchart" {
        let mut warning = format!(
            "{} diagram: the nodes/edges diff is partial for this diagram type",
            model.kind
        );
        if !baseline {
            warning.push_str("; source_hunks shows every text change");
        }
        out.push(warning);
    } else if model.nodes.is_empty() {
        out.push("diagram has no nodes".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mmx008_d_valid_flowchart_syntax_table() {
        for line in [
            "A>asym]",
            "A[/x/]",
            r"A[\x\]",
            "A[(db)]",
            "A((c))",
            "A(((c)))",
            "A{{h}}",
            "A[\"(quoted ]\"]",
            "A -->|a (b| B",
            "A -- text --> B",
            "A -.-> B",
            "A ==> B",
            "click A \"https://x.y/(z)\"",
            "classDef w fill:#f00",
            "style A stroke-width:2px",
            "linkStyle 0 stroke:#f00",
            "subgraph S [Title]",
            "A:::cls --> B",
        ] {
            assert!(check(&format!("flowchart TD\n{line}\n")).is_ok(), "{line}");
        }
    }
}
