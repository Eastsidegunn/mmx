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
        for (col, &ch) in chars.iter().enumerate() {
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
    }
    Ok(())
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
