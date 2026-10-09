//! `mmx render --layout-search N`: try N deterministic permutations of the
//! top-level node declaration lines and of the edge lines of a flowchart,
//! and keep the one with the fewest edge crossings. Declaration order is the
//! one layout input the source controls without changing the graph, so the
//! winner is an ordinary source edit that the turn records like any other
//! (it shows up in `source_hunks`). Every candidate must parse to the same
//! graph as the original; one that does not is discarded.

use crate::{lint, render, state};

pub const MAX_VARIANTS: usize = 500;

pub enum Search {
    /// Nothing to search: the reason, for stderr.
    Skipped(&'static str),
    Done {
        before: usize,
        after: usize,
        searched: usize,
        /// Whether edge lines were reordered too. Not when a `~~~` link or
        /// a numeric `linkStyle` is present: mermaid.js counts `~~~` links
        /// in `linkStyle` indices (the pinned renderer drops them), so a
        /// moved edge line could retarget a `linkStyle` for other renderers.
        edges: bool,
        /// The winning source when it beats the original order.
        source: Option<String>,
    },
}

/// A movable run of lines: a node declaration or an edge, together with the
/// comment lines directly above it (a comment describes what follows it).
struct Unit {
    lines: Vec<usize>,
    edge: bool,
}

/// Parse errors come back as the lint/renderer would report them, so the
/// caller can leave them to the normal render; a renderer failure is fatal.
pub fn search(source: &str, variants: usize) -> Result<Search, render::TurnError> {
    lint::check(source)?;
    if !is_flowchart(source) {
        return Ok(Search::Skipped("not a flowchart"));
    }
    // Work on LF text; the file's dominant line ending is restored on
    // every candidate, so a reorder never mixes endings.
    let crlf = source.matches("\r\n").count() * 2 > source.matches('\n').count();
    let source = source.replace("\r\n", "\n");
    let source = source.as_str();
    let trailing_newline = source.ends_with('\n');
    let lines: Vec<String> = source
        .split_inclusive('\n')
        .map(|l| {
            if l.ends_with('\n') {
                l.to_owned()
            } else {
                format!("{l}\n")
            }
        })
        .collect();
    if lines.iter().any(|l| first_word(l) == "subgraph") {
        return Ok(Search::Skipped("diagram has subgraphs"));
    }
    if lines
        .iter()
        .any(|l| matches!(first_word(l), "accTitle" | "accDescr"))
    {
        return Ok(Search::Skipped("accTitle/accDescr present"));
    }
    let units = match units(&lines) {
        Ok(units) => units,
        Err(reason) => return Ok(Search::Skipped(reason)),
    };
    let edges = !lines.iter().any(|l| {
        let t = l.trim();
        !t.starts_with("%%")
            && (t.contains("~~~")
                || (first_word(t) == "linkStyle"
                    && t["linkStyle".len()..]
                        .trim_start()
                        .starts_with(|c: char| c.is_ascii_digit())))
    });
    let movable = |edge: bool| units.iter().filter(|u| u.edge == edge).count();
    if movable(false) < 2 && (!edges || movable(true) < 2) {
        return Ok(Search::Skipped("fewer than two node declarations or edges"));
    }
    let original = render::probe(source)?;
    let before = original.crossings;
    let searched = variants.min(MAX_VARIANTS);
    let mut rng = Rng::new(seed(source));
    let mut best = before;
    let mut winner = None;
    let node_slots: Vec<usize> = (0..units.len()).filter(|&i| !units[i].edge).collect();
    let edge_slots: Vec<usize> = (0..units.len())
        .filter(|&i| edges && units[i].edge)
        .collect();
    for _ in 0..searched {
        let mut order: Vec<usize> = (0..units.len()).collect();
        for slots in [&node_slots, &edge_slots] {
            let mut picked = slots.clone();
            rng.shuffle(&mut picked);
            for (slot, from) in slots.iter().zip(picked) {
                order[*slot] = from;
            }
        }
        let mut candidate = assemble(&lines, &units, &order);
        if !trailing_newline {
            candidate.pop();
        }
        if crlf {
            candidate = candidate.replace('\n', "\r\n");
        }
        // A variant that fails lint, cannot be laid out, or parses to a
        // different graph is simply not a candidate.
        if lint::check(&candidate).is_err() {
            continue;
        }
        if let Ok(probe) = render::probe(&candidate) {
            if probe.signature == original.signature && probe.crossings < best {
                best = probe.crossings;
                winner = Some(candidate);
            }
        }
    }
    Ok(Search::Done {
        before,
        after: best,
        searched,
        edges,
        source: winner,
    })
}

/// The source with unit slot `k` filled by unit `order[k]`; every other
/// line stays where it is.
fn assemble(lines: &[String], units: &[Unit], order: &[usize]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        match units.iter().position(|u| u.lines[0] == i) {
            Some(slot) => {
                for &line in &units[order[slot]].lines {
                    out += &lines[line];
                }
                i += units[slot].lines.len();
            }
            None => {
                out += &lines[i];
                i += 1;
            }
        }
    }
    out
}

/// The movable units, or why the file is not searchable: an id declared
/// twice (the later label would win), or a label that is not closed on its
/// own line (a multi-line string).
fn units(lines: &[String]) -> Result<Vec<Unit>, &'static str> {
    let mut units = Vec::new();
    let mut comments: Vec<usize> = Vec::new();
    let mut declared: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.starts_with("%%") {
            comments.push(i);
            continue;
        }
        let kind = classify(line);
        if kind.is_some() && !balanced(t) {
            return Err("a label spans more than one line");
        }
        match kind {
            Some(Line::Declaration(id)) => {
                if declared.contains(&id) {
                    return Err("a node is declared more than once");
                }
                declared.push(id);
                comments.push(i);
                units.push(Unit {
                    lines: std::mem::take(&mut comments),
                    edge: false,
                });
            }
            Some(Line::Edge) => {
                comments.push(i);
                units.push(Unit {
                    lines: std::mem::take(&mut comments),
                    edge: true,
                });
            }
            None => comments.clear(),
        }
    }
    Ok(units)
}

enum Line {
    Declaration(String),
    Edge,
}

const KEYWORDS: [&str; 12] = [
    "flowchart",
    "graph",
    "subgraph",
    "end",
    "classDef",
    "class",
    "style",
    "linkStyle",
    "click",
    "direction",
    "accTitle",
    "accDescr",
];

/// A top-level `id[label]`-style line (an identifier followed by a shape
/// opener, no edge operator) or an edge line. Directives, comments, blank
/// lines and the header stay where they are.
fn classify(line: &str) -> Option<Line> {
    let t = line.trim();
    if t.is_empty() || t.starts_with("%%") {
        return None;
    }
    let word = first_word(t);
    if word.is_empty() || KEYWORDS.contains(&word) {
        return None;
    }
    if ["--", "-.", "==", "~~"].iter().any(|op| t.contains(op)) {
        return Some(Line::Edge);
    }
    t[word.len()..]
        .trim_start()
        .starts_with(['[', '(', '{', '>'])
        .then(|| Line::Declaration(word.to_owned()))
}

fn first_word(line: &str) -> &str {
    let t = line.trim_start();
    let end = t
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(t.len());
    &t[..end]
}

/// Quotes and backticks close on the line, and brackets outside quotes
/// balance: the line is a whole statement.
fn balanced(line: &str) -> bool {
    let (mut quoted, mut ticked) = (false, false);
    let mut depth: Vec<char> = Vec::new();
    for c in line.chars() {
        match c {
            '"' if !ticked => quoted = !quoted,
            '`' if !quoted => ticked = !ticked,
            _ if quoted || ticked => {}
            '[' | '(' | '{' => depth.push(c),
            ']' | ')' | '}' => {
                let open = match c {
                    ']' => '[',
                    ')' => '(',
                    _ => '{',
                };
                if depth.pop() != Some(open) {
                    return false;
                }
            }
            _ => {}
        }
    }
    !quoted && !ticked && depth.is_empty()
}

/// The first statement after comments and front matter is a flowchart
/// header (lint has already required a header).
fn is_flowchart(source: &str) -> bool {
    let mut front = false;
    let mut first = true;
    for line in source.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if first && t == "---" {
            front = true;
            first = false;
            continue;
        }
        first = false;
        if front {
            front = t != "---";
            continue;
        }
        if t.starts_with("%%") {
            continue;
        }
        return matches!(first_word(t), "flowchart" | "graph");
    }
    false
}

/// Reproducible, and a larger N explores a superset of a smaller one: the
/// same source gives the same variant sequence on every run.
fn seed(source: &str) -> u64 {
    let hash = state::hex_sha256(source.as_bytes());
    u64::from_str_radix(&hash[..16], 16).unwrap_or(0)
}

/// splitmix64: small, dependency-free, good enough for shuffling.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            items.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CROSSY: &str = "flowchart TD\n    A[a]\n    B[b]\n    C[c]\n    D[d]\n    E[e]\n    F[f]\n    A --> E\n    A --> D\n    B --> F\n    B --> D\n    C --> F\n    C --> E\n    E --> B\n    D --> C\n";

    fn done(source: &str, n: usize) -> (usize, usize, usize, Option<String>) {
        match search(source, n).unwrap() {
            Search::Done {
                before,
                after,
                searched,
                source,
                ..
            } => (before, after, searched, source),
            Search::Skipped(reason) => panic!("skipped: {reason}"),
        }
    }

    fn skipped(source: &str) -> &'static str {
        match search(source, 5).unwrap() {
            Search::Skipped(reason) => reason,
            Search::Done { .. } => panic!("not skipped"),
        }
    }

    #[test]
    fn lines_are_classified() {
        let decl = |l: &str| matches!(classify(l), Some(Line::Declaration(_)));
        let edge = |l: &str| matches!(classify(l), Some(Line::Edge));
        assert!(decl("    A[Start]\n"));
        assert!(decl("  node_1{\"Decision?\"}"));
        assert!(decl("B([round])"));
        assert!(decl("C>flag]"));
        assert!(decl("    A[x]:::cls"));
        assert!(edge("    A[Start] --> B[End]"));
        assert!(edge("    A -.->|x| B"));
        assert!(edge("    A & B ==> C"));
        assert!(classify("    %% A[comment]").is_none());
        assert!(classify("    classDef x fill:#fff").is_none());
        assert!(classify("    class A,B x").is_none());
        assert!(classify("    style A fill:#fff").is_none());
        assert!(classify("    linkStyle 0 stroke:#f00").is_none());
        assert!(classify("flowchart TD").is_none());
        assert!(classify("    A & B").is_none());
        assert!(classify("    end").is_none());
        assert!(decl("    endpoint[Endpoint]"));
        assert!(decl("    classDefault[Not a keyword]"));
    }

    #[test]
    fn unbalanced_lines_are_detected() {
        assert!(balanced("A[\"x (y\"]"));
        assert!(balanced("A --> B"));
        assert!(!balanced("A[\"first line"));
        assert!(!balanced("A[`markdown"));
        assert!(!balanced("A[open"));
        assert!(!balanced("A(x]"));
    }

    #[test]
    fn unsearchable_files_are_skipped() {
        assert_eq!(
            skipped("flowchart TD\n    A[a]\n    B[b]\n    subgraph S\n      A --> B\n    end\n"),
            "diagram has subgraphs"
        );
        assert_eq!(
            skipped("erDiagram\n    A ||--o{ B : has\n    C ||--o{ D : has\n"),
            "not a flowchart"
        );
        assert_eq!(
            skipped("flowchart TD\n    A[a]\n    B[b]\n    A[again]\n    A --> B\n"),
            "a node is declared more than once"
        );
        // A label spanning lines is a lint error first; the unit scan is the
        // backstop and names it.
        let multi = "flowchart TD\n    A[\"first\n    second\"]\n    B[b]\n    A --> B\n";
        assert!(search(multi, 5).is_err());
        let lines: Vec<String> = multi.split_inclusive('\n').map(str::to_owned).collect();
        assert_eq!(
            units(&lines).err(),
            Some("a label spans more than one line")
        );
        assert_eq!(
            skipped("flowchart TD\n    A --> B\n"),
            "fewer than two node declarations or edges"
        );
        assert_eq!(
            skipped("flowchart TD\n    accTitle: Flow\n    A[a]\n    B[b]\n    A --> B\n"),
            "accTitle/accDescr present"
        );
        assert_eq!(
            skipped("flowchart TD\n    accDescr {\n      A --> B\n    }\n    A[a]\n    B[b]\n    A --> B\n"),
            "accTitle/accDescr present"
        );
        // Only edges can move, and they may not: nothing to search.
        assert_eq!(
            skipped("flowchart TD\n    A --> B\n    B --> C\n    linkStyle 0 stroke:#f00\n"),
            "fewer than two node declarations or edges"
        );
    }

    fn edge_lines(text: &str) -> Vec<&str> {
        text.lines()
            .filter(|l| matches!(classify(l), Some(Line::Edge)))
            .collect()
    }

    #[test]
    fn linkstyle_or_invisible_link_pins_edge_order() {
        for extra in ["    linkStyle 2 stroke:#f00\n", "    A ~~~ F\n"] {
            let source = format!("{CROSSY}{extra}");
            let (edges, winner) = match search(&source, 40).unwrap() {
                Search::Done { edges, source, .. } => (edges, source),
                Search::Skipped(reason) => panic!("skipped: {reason}"),
            };
            assert!(!edges, "{extra}");
            if let Some(winner) = winner {
                assert_eq!(edge_lines(&winner), edge_lines(&source), "{extra}");
            }
        }
        // `linkStyle default` names no index, so edges stay searchable.
        let source = format!("{CROSSY}    linkStyle default stroke:#f00\n");
        assert!(matches!(
            search(&source, 1).unwrap(),
            Search::Done { edges: true, .. }
        ));
    }

    #[test]
    fn crlf_endings_are_kept_uniform() {
        let source = CROSSY.replace('\n', "\r\n");
        for text in [source.as_str(), source.trim_end_matches("\r\n")] {
            let (before, after, _, winner) = done(text, 40);
            assert!(after < before);
            let winner = winner.unwrap();
            assert_eq!(winner.matches('\n').count(), winner.matches("\r\n").count());
            assert_eq!(winner.ends_with("\r\n"), text.ends_with("\r\n"));
            assert!(!winner.ends_with('\r'));
            let mut a: Vec<&str> = text.lines().collect();
            let mut b: Vec<&str> = winner.lines().collect();
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn search_improves_deterministically_and_keeps_the_graph() {
        let first = done(CROSSY, 40);
        assert_eq!(first, done(CROSSY, 40));
        assert!(first.0 > 0);
        assert!(first.1 < first.0, "{first:?}");
        assert_eq!(first.2, 40);
        let winner = first.3.as_deref().expect("a better order was written");
        assert_eq!(render::probe(winner).unwrap().crossings, first.1);
        assert_eq!(
            render::probe(winner).unwrap().signature,
            render::probe(CROSSY).unwrap().signature
        );
        let mut a: Vec<&str> = CROSSY.lines().collect();
        let mut b: Vec<&str> = winner.lines().collect();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b);
        // A larger N starts with the same variants, so it is never worse.
        assert!(done(CROSSY, 60).1 <= first.1);
    }

    #[test]
    fn missing_final_newline_moves_whole_lines() {
        let source = CROSSY.trim_end_matches('\n');
        let (before, after, _, winner) = done(source, 40);
        assert!(after < before);
        let winner = winner.unwrap();
        assert!(!winner.ends_with('\n'));
        let mut a: Vec<&str> = source.lines().collect();
        let mut b: Vec<&str> = winner.lines().collect();
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b);
    }

    #[test]
    fn comments_travel_with_their_line() {
        let source = "flowchart TD\n    %% note on A\n    A[a]\n    B[b]\n    %% edge one\n    A --> B\n    %% edge two\n    B --> A\n";
        let lines: Vec<String> = source.split_inclusive('\n').map(str::to_owned).collect();
        let units = units(&lines).unwrap();
        assert_eq!(units.len(), 4);
        assert_eq!(units[0].lines, vec![1, 2]);
        assert_eq!(units[3].lines, vec![6, 7]);
        let order = [1, 0, 3, 2];
        assert_eq!(
            assemble(&lines, &units, &order),
            "flowchart TD\n    B[b]\n    %% note on A\n    A[a]\n    %% edge two\n    B --> A\n    %% edge one\n    A --> B\n"
        );
    }

    #[test]
    fn cap_applies() {
        let source = "flowchart LR\n    A[a]\n    B[b]\n    A --> B\n";
        assert_eq!(done(source, 10_000).2, MAX_VARIANTS);
    }
}
