# Research and analysis tasks

Read this before writing the brief for a research task; the evidence review before research conclusions are recorded is here too. Research tasks are work whose conclusions rest on experiments and data, such as strategy and factor research, data analysis, comparison experiments and performance investigations. The risk here isn't buggy code; it's conclusions that go beyond the evidence.

## What the brief adds
When handing research off, the brief must cover the items below on top of the general structure in `references/run.md`. If an item doesn't apply, say so and why instead of leaving it out. Questions and hypotheses already settled in a discussion go straight in; don't discuss them again.
- **Questions and hypotheses**: the questions to answer, and each hypothesis with the criteria for judging it. Fix the criteria in advance; don't change them after seeing results.
- **Controls**: which controls and baselines are needed, and what each one answers.
- **Robustness**: how to check that a result isn't a fluke of one parameter point or one period, for example parameter neighborhoods, splitting time periods, different starting points.
- **Confounders**: list what could distort the conclusions, and require each to be ruled out or explained as not applicable. Common ones: capital or size path (changing capital, round-lot limits), sample exposure (choosing after seeing results), multiple testing, survivorship bias, changes in how data is defined.
- **Statistics**: how to judge whether a difference is significant, and how to correct for comparing many groups.
- **Deliverables**: the evidence behind each conclusion (files, numbers, a way to recompute it), and anything that couldn't be verified.

## Evidence review before conclusions are recorded
Before research conclusions go into long-term records, reports or docs, or are handed to the user as settled, whoever did the research, start a level 3 review as an evidence review (`review --target claims`; every seat is a new session, never the one that did the research), as `references/review.md` describes: the review brief lists each conclusion with where its evidence is and the key numbers, and the evidence files go in with `--file`; the reviewers judge each one: is the evidence enough, does it overstate, are there uncontrolled confounders, does it hold up statistically. The number of seats is the `seats` configured for level 3 reviews; if the user wants evidence reviews to use every model, set `review.seats.complex` to the number of candidates in the cell. Claude checks each finding as in "After the review" in review.md and corrects the conclusions before recording them. If a conclusion already recorded is overturned, correct it with an appended revision rather than editing the original.
