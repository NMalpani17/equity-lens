"""Deterministic clean-up of numbers and tables in the model's final answer.

The prompt asks for these too; this is the safety net for what slips through:

- No double negatives: "down -$13,457" -> "down $13,457".
- Whole share counts without decimals: "42.0 shares" -> "42 shares", while
  fractional counts ("0.5 shares") are kept.
- No lists inside Markdown table cells (raw HTML such as <br> isn't rendered,
  so "• a<br>• b" would collapse into one run-on cell): "a; b".
"""

import re

# A decline word followed by a minus sign on the amount, e.g. "down -$13,457",
# "fell −2.4%", "a loss of -$120". The direction is already in the word.
_DOUBLE_NEGATIVE_RE = re.compile(
    r"\b(down|lower|fell|dropped|declined|decreased|lost|loss of|decline of|"
    r"decrease of|drop of|(?:declined|decreased|dropped|fell) by)"
    r"(\s+)[-−–](?=\s?[$€£]?\d)\s?",
    re.IGNORECASE,
)
_WHOLE_SHARES_RE = re.compile(
    r"\b(\d{1,3}(?:,\d{3})*|\d+)\.0+(?=\s+shares?\b)", re.IGNORECASE
)
_CELL_BREAK_RE = re.compile(r"\s*<br\s*/?>\s*", re.IGNORECASE)
# A bullet marker at the start of a cell or of a line inside it.
_CELL_BULLET_RE = re.compile(r"(^|;\s)\s*[-*•]\s+")
_CELL_NUMBERED_RE = re.compile(r"(^|;\s)\s*\d{1,2}[.)]\s+")


def whole_shares(value: float | None) -> float | int | None:
    """42.0 -> 42 for tool output; fractional share counts are unchanged."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def tidy_answer(text: str) -> str:
    """Apply the number and table fixes outside fenced code blocks."""
    parts = re.split(r"(```.*?```)", text, flags=re.DOTALL)
    return "".join(
        part if part.startswith("```") else _tidy_prose(part) for part in parts
    )


def _tidy_prose(text: str) -> str:
    text = _DOUBLE_NEGATIVE_RE.sub(r"\1\2", text)
    text = _WHOLE_SHARES_RE.sub(r"\1", text)
    return "\n".join(
        _tidy_table_row(line) if line.lstrip().startswith("|") else line
        for line in text.split("\n")
    )


def _tidy_table_row(line: str) -> str:
    cells = line.split("|")
    return "|".join(_tidy_cell(cell) for cell in cells)


def _tidy_cell(cell: str) -> str:
    content = cell.strip()
    had_breaks = bool(_CELL_BREAK_RE.search(content))
    if not had_breaks and not _CELL_BULLET_RE.match(content):
        return cell
    flattened = _CELL_BULLET_RE.sub(r"\1", _CELL_BREAK_RE.sub("; ", content))
    if had_breaks:  # "1. a<br>2. b" was a numbered list
        flattened = _CELL_NUMBERED_RE.sub(r"\1", flattened)
    return f" {flattened.strip('; ').strip()} "
