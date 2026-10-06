---
name: mmx-meeting
description: "Use when turning a recorded meeting (a Tiro note: summary + transcript) into picture minutes with mmx — a Mermaid diagram of decisions, open questions, action items and their evidence that the human corrects on the picture. Also use when the human edits those minutes in mmx serve and the minutes text must follow."
---

# Picture minutes from a Tiro meeting

Turn a finished meeting into **picture minutes**: one Mermaid diagram the
human can correct directly on the picture (`mmx serve`), plus a short text
minutes file generated from it. The diagram is the editing surface; the
text follows the diagram.

Requires `mmx` 0.4+ (see the `mmx` skill for the turn protocol) and the
Tiro CLI (`npm install -g @theplato/tiro-cli`, then the human runs
`tiro auth login` once; the token lives in the OS keychain — never ask for,
print or store an API key).

## 1. Fetch the meeting

```bash
tiro notes list --limit 10 --json                     # recent notes, one JSON object per line
tiro notes search "<keyword>" --since 7d --json        # or find by keyword/date
tiro notes get <noteGuid> --include transcript --output /tmp/<slug>.note.md
tiro notes transcript <noteGuid> --format json > /tmp/<slug>.transcript.json
```

Ask the human which meeting if more than one matches. Keep the fetched
files outside the repository (they are the human's private data); do not
commit transcripts or real minutes to a public repository.

## 2. Extract

From the summary and the transcript, collect:

| kind | what counts | id | Mermaid shape |
|---|---|---|---|
| topic | an agenda item or a distinct thread of discussion | `T1`… | stadium `T1(["…"])` |
| decision | something the group agreed on | `D1`… | hexagon `D1{{"…"}}` |
| open question | raised, not settled | `Q1`… | rhombus `Q1{"…?"}` |
| action item | a task with an owner (and a due date if said) | `A1`… | rectangle `A1["Owner: task (due)"]` |
| evidence | the moment that supports a decision/action | `E1`… | rounded `E1("speaker, mm:ss")` |

Rules:
- Only what was actually said. No owner or date that nobody stated —
  write `Owner: ?` and add an open question instead.
- Labels are short (≤ 40 characters) in the meeting's language; the full
  wording goes into the text minutes under the same id.
- Ids are stable for the life of the minutes: never renumber. New items
  get the next free number.

## 3. Draw

```
flowchart LR
    %% <meeting title> — <date> — picture minutes (ids: T topic, D decision, Q question, A action, E evidence)
    T1(["Checkout flow"]) --> D1{{"Ship one-page checkout"}} --> A1["Mina: prototype (Fri)"]
    T1 --> Q1{"Keep guest checkout?"}
    E1("Mina, 02:05: 31% to 19%") -.-> D1
    classDef decision fill:#e8f5e9,stroke:#2e7d32
    classDef question fill:#fff8e1,stroke:#f9a825
    classDef action fill:#e3f2fd,stroke:#1565c0
    classDef evidence fill:#f5f5f5,stroke:#9e9e9e,color:#555
    class D1 decision
    class Q1 question
    class A1 action
    class E1 evidence
```

- One lane per topic, left to right: `topic --> decision --> action`,
  `topic --> question`. Use `flowchart LR` and **no subgraphs**: with the
  pinned renderer, subgraphs leave large empty areas and stretch the
  picture; topic nodes keep each lane compact and give the human a topic
  label to rename.
- `decision --> action` when the action carries the decision out; an
  action that came from an open question hangs off the question.
  Do not add edges just to connect things.
- Evidence uses a dashed arrow into what it supports.
- **Size:** at most ~30 nodes per diagram. Above that, write an overview
  (`<slug>.mmd`: topic nodes with their decisions only) and one
  diagram per topic (`<slug>-T2.mmd`, …). Keep at most one evidence node
  per decision in the picture; the rest go into the text minutes.

First turn:

```bash
mmx render <slug>.mmd --by agent --note "Draft minutes: N decisions, M open questions, K action items — correct anything on the picture"
```

Then write `<slug>.minutes.md` (see §5) and tell the human to run
`mmx serve <slug>.mmd`.

## 4. Read the human's corrections

Run `mmx wait <slug>.mmd --timeout 300`. Each human turn is a diff (see the
`mmx` skill for the format). Read it as edits to the minutes:

| diff | meaning for the minutes |
|---|---|
| `nodes.changed` label on D/Q/A | the wording was wrong — use the human's wording |
| `nodes.removed` D/A/Q | not a decision / not an action / not open — drop it from the text, list it under "Removed in review" |
| `nodes.added` (new id such as `n1`) | a missing item; classify it by its label (ask in a note if unclear) and give it the next proper id |
| an edge `Q → D` added | the question was settled by that decision |
| an edge `D → A` added or removed | the action does / does not carry out that decision |
| edge style dashed ↔ solid | tentative ↔ confirmed |
| `source_hunks` only (e.g. a `class` line) | the human re-classified an item — follow it |
| `moved` | layout only — ignore |
| `note` | an instruction or a correction in words — apply it |

After applying: update `<slug>.minutes.md`, keep ids, then
`mmx render <slug>.mmd --by agent --note "<what you changed>"` (or
`mmx note` if only the text changed) and wait again.

## 5. Text minutes

`<slug>.minutes.md`, regenerated from the diagram after every turn:

```
# <meeting title> — <date>
Participants: …   Source: Tiro note <noteGuid>

## Decisions
- D1 Ship one-page checkout. (Jun, 04:12)
## Action items
- A1 Mina — prototype — due Fri. (from D1)
## Open questions
- Q1 Keep guest checkout?
## Removed in review
- …
```

Every line starts with its diagram id so the picture and the text can be
matched at a glance.
