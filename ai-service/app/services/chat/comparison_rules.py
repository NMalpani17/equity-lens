"""How a quarter-over-quarter comparison is written (chat and research report).

One set of rules, so the chat answer to "what changed" and the report's
"What changed vs last quarter" section classify changes the same way.
"""

COMPARISON_HEADINGS = (
    "New",
    "Raised / improved",
    "Lowered / worse",
    "No longer mentioned",
    "Unchanged",
)
# The closing line's status, after the categories with nothing to report.
NOTHING_FOUND = "nothing found in the retrieved passages"

COMPARISON_RULES = """\
- Put the changes under these headings, in this order, using only the ones \
that have content: "### New", "### Raised / improved", "### Lowered / worse", \
"### No longer mentioned", "### Unchanged". Use no other headings.
- Use "Raised / improved" or "Lowered / worse" only when the value or \
position itself changed between the two quarters (e.g. revenue guidance went \
from $45 billion to $54 billion). If it is the same in both quarters (e.g. a \
16%-18% tax rate both times), it goes under "Unchanged", even when management \
reaffirmed or repeated it.
- End with one closing line that names the categories with nothing to report \
first, then the status: "No longer mentioned: nothing found in the retrieved \
passages." With several empty categories, list them in heading order: \
"Lowered / worse, No longer mentioned: nothing found in the retrieved \
passages." If every category has content, leave the line out.
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
