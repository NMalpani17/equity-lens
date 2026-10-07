"""How a quarter-over-quarter comparison is written (chat and research report).

One set of rules, so the chat answer to "what changed" and the report's
"What changed vs last quarter" section classify changes the same way.

Changes compare like with like: guidance with the earlier guidance for the
same metric and kind of period, reported results with earlier results. How a
result compares with the guidance given for it is not a change in either
direction; it goes under its own heading, worded met / beat / missed.
"""

# The change categories (the closing line names the empty ones).
CHANGE_HEADINGS = (
    "New",
    "Raised / improved",
    "Lowered / worse",
    "No longer mentioned",
    "Unchanged",
)
RESULTS_VS_GUIDANCE = "Results vs guidance"
# Every heading a comparison may use, in order.
COMPARISON_HEADINGS = (*CHANGE_HEADINGS, RESULTS_VS_GUIDANCE)
# The closing line's status, after the categories with nothing to report.
NOTHING_FOUND = "nothing found in the retrieved passages"

COMPARISON_RULES = """\
- Put the changes under these headings, in this order, using only the ones \
that have content: "### New", "### Raised / improved", "### Lowered / worse", \
"### No longer mentioned", "### Unchanged", then "### Results vs guidance" \
if there is anything for it. Use no other headings.
- Compare like with like. Guidance is compared only with the earlier \
quarter's guidance for the same metric and the same kind of period (e.g. \
next-quarter revenue growth guided at 14-17% in the earlier call vs 9-11% in \
the newer call is Lowered / worse). A reported result is compared only with \
the earlier quarter's reported result for the same metric.
- A reported result measured against the guidance given for it is not a \
change: never put it under Raised / improved or Lowered / worse, and never \
call it raised or lowered. It goes under "### Results vs guidance", worded as \
met, beat or missed (e.g. "Q3 FY2026 revenue grew 16%, within the 14-17% \
guidance given in Q2 FY2026: met").
- Use "Raised / improved" or "Lowered / worse" only when the value or \
position itself changed between the two quarters (e.g. revenue guidance went \
from $45 billion to $54 billion). If it is the same in both quarters (e.g. a \
16%-18% tax rate both times), it goes under "Unchanged", even when management \
reaffirmed or repeated it.
- End the change categories with one closing line that names the ones with \
nothing to report first, then the status: "No longer mentioned: nothing found \
in the retrieved passages." With several empty categories, list them in \
heading order: "Lowered / worse, No longer mentioned: nothing found in the \
retrieved passages." It covers only New, Raised / improved, Lowered / worse, \
No longer mentioned and Unchanged. If every one of them has content, leave the \
line out.
- Cite every claim with a passage from the quarter it describes: the newer \
position cites a newer-quarter passage, the earlier position an \
earlier-quarter passage, and a change cites both.
- Under "New", describe an item only as newly discussed in the newer \
quarter's retrieved passages. Never claim it didn't happen, wasn't said or \
wasn't discussed in the earlier quarter; if the earlier quarter's retrieved \
passages don't cover it, write "not discussed in the retrieved Q1 FY2027 \
passages" (with the earlier quarter's label).
- Something is "no longer mentioned" only if an earlier-quarter passage \
discusses it and none of the newer quarter's retrieved passages do. Word it \
as "not discussed in the retrieved Q2 FY2027 passages", never as management \
dropping or abandoning it; absence from retrieved passages is not proof.
- Keep management's wording for forecasts and guidance in both quarters."""
