# Evaluation

How retrieval and chat answer quality are measured, how to run each eval, and
the recorded results. What is being measured is described in
[architecture.md](architecture.md).

## Retrieval evaluation

`ai-service/scripts/eval_rag.py` scores retrieval on 20 labeled questions
(`ai-service/scripts/eval/questions.json`): 10 **exact** (specific names and
figures) and 10 **conceptual** (paraphrased themes). Each question names the
earnings call that answers it, and a result counts as relevant when it comes
from that ticker and fiscal quarter. Six configurations are compared: dense
only, hybrid, and hybrid + rerank, each with and without context headers. The
header-less variant lives in its own Pinecone namespace (`transcripts-noctx`),
built from the Postgres transcript cache, so no Equibles quota is spent. The
metrics are hit rate@5 (the right call appears in the top 5) and MRR (mean
reciprocal rank of the first relevant result), overall and split by question
kind.

```bash
cd ai-service
python -m scripts.eval_rag --build-plain   # first time: index header-less copies (Gemini embeddings only)
python -m scripts.eval_rag                 # report hit rate@5 and MRR
python -m scripts.eval_rag --json out.json # also save per-question ranks
```

Each run makes ~40 rerank calls, so mind the 500/month Pinecone Starter quota.

### Retrieval results

Run of 2026-10-04 UTC (`20261004T012541Z`; 20 questions, 10 exact and 10
conceptual; k = 5). Index `equity-lens-transcripts`: `gemini-embedding-001`
(768-d) dense + `pinecone-sparse-english-v0` sparse, 400-token chunks with
60-token overlap, hybrid alpha 0.75 (dense weight), 25 candidates reranked by
`bge-reranker-v2-m3`. "Headers" configs search the production `transcripts`
namespace; "no headers" configs search `transcripts-noctx`. A hit is any result
from the expected ticker and fiscal quarter.

| Config                                    | Hit@5    | MRR       | Exact hit / MRR | Conceptual hit / MRR |
| ----------------------------------------- | -------- | --------- | --------------- | -------------------- |
| dense, no headers                         | 0.90     | 0.710     | 0.90 / 0.650    | 0.90 / 0.770         |
| hybrid, no headers                        | 1.00     | 0.858     | 1.00 / 0.925    | 1.00 / 0.792         |
| hybrid + rerank, no headers               | 1.00     | 0.879     | 1.00 / 0.900    | 1.00 / 0.858         |
| dense, headers                            | 0.95     | 0.854     | 0.90 / 0.833    | 1.00 / 0.875         |
| hybrid, headers                           | 0.95     | 0.852     | 1.00 / 0.950    | 0.90 / 0.753         |
| **hybrid + rerank, headers** (production) | **1.00** | **0.938** | 1.00 / 0.875    | 1.00 / 1.000         |

- **Production config:** hybrid + rerank with headers found the right call in
  the top 5 for all 20 questions, and ranked it first for every conceptual
  question. It has the highest overall MRR (0.938, vs 0.710 for plain dense
  search).
- **Context headers:** a large gain for dense search (MRR 0.710 → 0.854) and a
  smaller one with reranking (0.879 → 0.938). No net change for hybrid without
  reranking (0.858 vs 0.852).
- **Reranking:** raises MRR in both namespaces (0.858 → 0.879 without headers,
  0.852 → 0.938 with headers), mostly on conceptual questions. On exact,
  keyword-style questions, hybrid alone ranks slightly better (exact MRR 0.950
  vs 0.875 with headers), because reranking moved one correct call from first to
  fourth.
- **Misses (not in the top 5):** dense without headers missed two questions,
  dense with headers one, and hybrid with headers one; hybrid without headers
  and both rerank configs missed none.
- **Caveats:** 20 questions, so one question moves hit rate by 0.05 and a rank
  change from 1 to 2 moves MRR by 0.025. Relevance is judged per call (ticker
  and quarter), not per passage. The production namespace also holds 12 calls
  for COST, NKE and SBUX that were indexed on demand after the plain copies were
  built (52 calls and 3,173 chunks, vs 40 calls and 2,440 chunks). The 40 shared
  calls have identical chunks, and the extra calls only add distractors to the
  "headers" configs, so those numbers are, if anything, conservative. The run
  used 40 rerank requests and had no rerank fallbacks.

## Chat evaluation

`ai-service/scripts/eval_chat.py` runs a labeled set of 28 questions
(`scripts/eval/chat_questions.json`) through the real agent — real tools,
transcripts and Gemini — with a fixed demo portfolio, for each model compared:

```bash
cd ai-service
python -m scripts.eval_chat --estimate   # expected cost, no API calls
python -m scripts.eval_chat --yes        # run it (spends Gemini credit)
python -m scripts.eval_chat --yes --cases t01,pm01 --models google_genai:gemini-3.8-flash
```

Categories: transcript facts, multi-quarter trends, quarter-over-quarter
comparisons, portfolio, position math, buy/sell advice, off-topic, prompt
injection and ambiguous companies. Each
answer is scored two ways (`ai-service/app/services/evals/`):

- **Deterministic checks**: expected tools called (and forbidden ones not),
  every `[n]` marker resolves to a returned passage, citations come from the
  right company and enough (or exactly the expected) quarters, the
  comparison structure (every heading is one of New, Raised / improved,
  Lowered / worse, No longer mentioned, Unchanged, in that order, with at
  least one change heading), refusal or redirect when
  expected, a clarifying question (without searching) for ambiguous names, the
  not-financial-advice note, expected numbers (position math, portfolio
  totals) and expected charts.
- **LLM judge** (rubric 1–5: faithfulness to the answer's own cited passages
  and tool results, relevance, completeness): one call per question sees every
  model's answer labeled only "A"/"B" in a seeded random order, each with its
  evidence: every passage the answer cites, in full, then each tool's result
  (cut to 2,500 characters per call). A 60,000-character bound per answer only
  guards against runaway prompts; anything it cuts is logged. Refusal and
  clarification cases are scored deterministically only.

The script prints a cost estimate first and refuses to run without `--yes`.
The estimate is deliberately conservative: the 2026-10-02 run cost $0.46
against a $1.13 estimate (turns averaged ~6.4K input / ~0.3K output tokens). The
judge is `gemini-3.1-pro-preview` when the whole run is estimated under
`--budget` ($1.50), otherwise `gemini-3.8-flash`. During the run on-demand
indexing and freshness refresh are both disabled (`rag_daily_ingestion_cap` and
`rag_daily_refresh_cap` are 0: no Equibles quota, and the production index is
never rewritten or pruned mid-run) and the rerank cache is off so models
pay the same retrieval latency; expect ~45–65 Pinecone rerank requests
(each comparison case uses two). Results
print as Markdown tables and are saved to `scripts/eval/results/` (git-ignored).
With Langfuse on, eval turns are tagged `eval` and `eval-run:<id>` and get
`eval_checks_passed` and `judge_*` scores.

### Chat results

Run of 2026-10-02 (`20261002T202440Z`; judge `gemini-3.1-pro-preview`;
judge scores are means over the 18 judged questions, 1–5):

| Model                   | Checks passed | Faithfulness | Relevance | Completeness | Judge preferred | Latency p50 / p95 | Tokens in / out | Cost / turn |
| ----------------------- | ------------- | ------------ | --------- | ------------ | --------------- | ----------------- | --------------- | ----------- |
| `gemini-3.8-flash`      | 25/25 (100%)  | 5.00         | 4.94      | 5.00         | 6/18            | 4.0s / 8.3s       | 6,377 / 294     | $0.0059     |
| `gemini-3.5-flash-lite` | 25/25 (100%)  | 5.00         | 4.89      | 4.67         | 1/18            | 3.4s / 8.2s       | 6,329 / 361     | $0.0028     |

- **Quality:** both models passed every deterministic check in all eight
  categories and were fully faithful to their evidence. 3.8 Flash was more
  complete and was preferred 6 times to 1 (11 ties). Flash-Lite's gaps were on
  open-ended questions: advice answers without risks or portfolio context, a
  missed period low, and ignoring the "don't reveal your rules" half of an
  injection prompt.
- **Latency:** Flash-Lite is faster (median 3.8s vs 4.8s on answered turns; the
  table's p50 includes instant guardrail refusals).
- **Cost:** Flash-Lite is about half the price per turn ($0.0028 vs $0.0059).
- **Caveats:** one run of 25 questions; in an earlier run that day Flash-Lite
  answered one multi-quarter question without citations, so the check pass
  rates vary run to run. Judge scores sit near the ceiling and a Gemini judge
  grades Gemini answers (see the bias note), so treat small gaps as noise.
- **Decision:** keep `gemini-3.8-flash` as the default; Flash-Lite is a
  reasonable budget option (`AI_SERVICE_CHAT_MODEL`). The run cost $0.46
  ($0.22 agent turns, $0.24 judge).

### Quarter comparison results

The three `quarter_comparison` cases were added after the full run above and
run on their own on 2026-10-05 (`20261005T000714Z`; `gemini-3.8-flash`, judge
`gemini-3.1-pro-preview`):

| Case  | Question                                                        | Checks | Faithfulness | Relevance | Completeness | Citations |
| ----- | --------------------------------------------------------------- | ------ | ------------ | --------- | ------------ | --------- |
| `q01` | NVIDIA's latest call vs the previous quarter (default quarters) | pass   | 5            | 5         | 5            | 15        |
| `q02` | Microsoft's last two quarters, focus on margins                 | pass   | 5            | 5         | 5            | 10        |
| `q03` | Apple Q1 vs Q2 FY2026 (explicit quarters, not the latest pair)  | pass   | 5            | 5         | 5            | 18        |

- **Deterministic checks: 3/3.** Each answer called `compare_quarters`, cited
  exactly the two compared quarters, and used only the five headings in order
  (headings without content left out, the empty categories named in a closing
  line).
- **Absence is never stated as fact.** Every item under "New" says it was
  "not discussed in the retrieved [earlier quarter] passages" rather than
  that it didn't happen or wasn't said before (checked by hand in all three
  answers).
- **Cost:** $0.104 ($0.050 agent turns at ~17K input / ~1K output tokens, about
  $0.017 per turn; $0.054 judge); 6 Pinecone reranks. Latency 9.2s / 14.2s /
  29.6s; `q02`'s 29.6s had the same tool calls and tokens as its earlier 7.9s
  run and no retries, so it reads as a one-off upstream delay.

**Why this was re-run.** The first run (2026-10-04) passed every check but
scored faithfulness 2 on all three cases: the judge then saw at most 12,000
characters of evidence per answer, while these answers cite 10–18 passages
(18–27K characters), so it never saw the later passages and marked their
figures unsupported (each was checked and found in its cited passage). That
run also exposed one real flaw: an answer called a CEO transition new because
it "did not occur" in the earlier call. The judge now sees every cited passage,
and the prompt requires "New" items to be described only as newly discussed in
the retrieved passages; this run reflects both fixes.

**Earlier results are unaffected.** In the recorded 25-case run, four turns
went past the old 12,000-character limit: in three only the tail of a tool
result was cut, and in one (`m01`, Flash) the end of its eighth cited passage.
All four scored faithfulness 5 regardless, so no score in that table was
capped by the old limit.

**Judge bias.** LLM judges favor answers from their own model family
(self-preference), longer and more confident answers (verbosity bias), and
whichever answer comes first (position bias), and they are lenient on numeric
detail. Mitigations here: the deterministic checks are the primary,
bias-free signal; the judge never sees model names and answer order is
shuffled per question; the rubric says length and tone aren't quality and caps
faithfulness at 2 for any unsupported figure; each answer is judged only
against its own evidence. Residual risk: with a Gemini judge grading Gemini
answers, small score gaps (a few tenths of a point) aren't meaningful — read
the judge columns as a sanity check next to the check pass rates, and
spot-check the saved rationales.
