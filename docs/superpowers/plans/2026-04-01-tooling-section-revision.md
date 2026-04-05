# Tooling Section Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite section `1.2.2 工具体系：65 个工具的分类逻辑` in `docs/claude_code_arch.md` so it reads as an analysis-report section that explains classification logic, permission flow, large-result handling, and concurrency safety.

**Architecture:** Treat the change as a focused documentation refactor inside a single Markdown file. Preserve the surrounding chapter rhythm and terminology, replace the current short subsection with a medium-length narrative that bridges tool taxonomy, runtime control, and execution safety, and keep boundaries clean relative to `1.2.1`, `1.2.8`, and `1.3.1`.

**Required content anchors:** The rewritten subsection should explicitly mention representative tool names and execution terms where they help concretize the analysis, including `FileRead`, `GlobTool`, `GrepTool`, `FileEdit`, `FileWrite`, `BashTool`, `PowerShellTool`, `MCPTool`, `SkillTool`, `permission_request`, `post_tool_use`, and `isConcurrencySafe`.

**Required writing form:** Follow the spec’s analysis-report structure: lead each major block with the conclusion, then explain the mechanism with structure, examples, or compact pseudo-flow. Do not write the section as a neutral catalog.

**Target size:** Replace the original short subsection with a medium expansion of roughly 80–120 lines of Markdown prose and block content.

**Tech Stack:** Markdown documentation, existing repository prose style, spec document at `docs/superpowers/specs/2026-04-01-tooling-section-design.md`.

---

### Task 1: Map exact edit surface and writing constraints

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-tooling-section-design.md`

- [ ] **Step 1: Re-read the current section and its neighboring sections**

Read:
- `docs/claude_code_arch.md` around `1.2.2`
- the end of `1.2.1`
- the start of `1.2.3`
- `1.2.8`
- `1.3.1`

Goal: identify exact tone, density, and what content should remain outside `1.2.2`.

- [ ] **Step 2: Extract the non-negotiable writing requirements from the spec**

Confirm the rewritten section must include:
- tool classification and responsibility split
- full permission-check chain
- large-result and temporary-file handling
- concurrency-safety strategy

Also extract the concrete anchors that should appear in the prose where relevant:
- representative tool names such as `FileRead`, `GlobTool`, `GrepTool`, `FileEdit`, `FileWrite`, `BashTool`, `PowerShellTool`, `MCPTool`, and `SkillTool`
- permission hook names such as `permission_request` and `post_tool_use`
- the concurrency flag `isConcurrencySafe`

Also confirm the section should stay medium-sized and analysis-report oriented.

- [ ] **Step 3: Write a mini outline before editing**

Draft this internal outline:
1. new opening thesis
2. runtime-oriented classification axes
3. responsibility layers
4. permission chain
5. large-result handling
6. concurrency safety
7. closing synthesis

Style guard for the outline:
- each major block should lead with the conclusion, then explain structure or examples
- use at least one compact pseudo-flow or bullet-chain where it clarifies mechanism
- keep the section in the same “先下判断，再解释机制” rhythm used by surrounding chapters

- [ ] **Step 4: Verify no unrelated sections will be edited**

Scope guard:
- only replace the body of `1.2.2`
- do not rewrite section titles outside this subsection
- do not alter table of contents unless anchor text needs to remain consistent
- keep the final subsection roughly in the spec target range of about 80–120 lines of Markdown prose/block content

### Task 2: Rewrite the subsection with the new structure

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-tooling-section-design.md`

- [ ] **Step 1: Replace the current opening paragraph with a higher-level thesis**

The new opening must establish that tools are classified not only by capability but by runtime control properties such as:
- side effects
- permission sensitivity
- output size
- concurrency safety
- workflow coordination role

Expected outcome: the first paragraph makes it obvious that this is an architectural analysis, not a tool catalog.

Form requirement:
- the paragraph should lead with the conclusion first, not with raw enumeration
- the paragraph must sound like an analysis verdict, not a descriptive introduction

- [ ] **Step 2: Add a section explaining runtime-oriented classification logic**

Include the four axes from the spec:
- capability domain
- side-effect level
- scheduling property
- control role

Expected outcome: readers understand why the same tool set can’t be understood by feature grouping alone.

Form requirement:
- start with the classification conclusion, then unpack the four axes
- use compact bullets or a short structured block rather than loose narrative only

- [ ] **Step 3: Expand responsibility layering from two classes to three layers**

Write and explain:
- execution tools
- coordination tools
- extension/bridge tools

Representative examples that should appear where appropriate:
- execution: `FileRead`, `GlobTool`, `GrepTool`, `FileEdit`, `FileWrite`, `BashTool`, `PowerShellTool`
- bridge: `MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `SkillTool`

Expected outcome: the text emphasizes that coordination and bridge tools shape how work happens, not just what gets done.

- [ ] **Step 4: Add the full permission-check chain narrative**

Cover the flow:
- tool_use emitted by the model
- schema/input normalization
- allow/deny/ask matching
- shell static risk analysis
- permission hook escalation if configured
- execution only after approval
- optional post-tool hooks afterward

Concrete names to include where relevant:
- `permission_request`
- `post_tool_use`

Form requirement:
- present the permission chain as an ordered flow or pseudo-pipeline, not as scattered observations

Expected outcome: readers see permission as part of the execution pipeline, not a separate UI detail.

- [ ] **Step 5: Add the large-result and temporary-file handling explanation**

Explain the three result sizes:
- small inline results
- truncated summary results
- oversized outputs written to temporary storage or external file locations

Examples that should appear where useful:
- large `git diff`
- long shell output
- broad search results
- long web fetch content

Expected outcome: readers understand why full raw output is not always injected back into model context.

- [ ] **Step 6: Add the concurrency-safety control explanation**

Explain:
- why read-only tools are often concurrency-safe
- why state-changing tools are isolated into serial batches
- how batching preserves both responsiveness and consistency

Concrete anchor to include:
- mention `isConcurrencySafe` explicitly as the key per-tool concurrency property

Representative examples that should appear where appropriate:
- concurrency-safe read operations such as `FileRead`, `GlobTool`, and `GrepTool`
- state-changing tools such as `FileEdit`, `FileWrite`, and `BashTool`

Expected outcome: this section naturally leads into `1.2.8` without duplicating its full implementation details.

- [ ] **Step 7: End with a synthesis paragraph**

Close with the core conclusion that the tool system is a controlled execution abstraction, not a plain API list.

### Task 3: Polish for consistency with the rest of the document

**Files:**
- Modify: `docs/claude_code_arch.md`

- [ ] **Step 1: Check terminology consistency**

Verify the section uses the same naming conventions already present in the document for:
- Agent Loop
- tool_result / tool_use
- hook names
- permission concepts
- MCP / Skill terminology

- [ ] **Step 2: Check section boundaries**

Confirm that:
- `1.2.2` does not fully re-explain `1.2.1`
- `1.2.2` does not swallow `1.2.8`
- `1.2.2` does not duplicate most of `1.3.1`

- [ ] **Step 3: Tighten prose for analysis-report style**

Edit sentences so they:
- lead with conclusions
- keep paragraph density high
- avoid fluffy transitions
- retain the existing report cadence
- prefer compact mechanism bullets or pseudo-flow when clarifying execution chains

- [ ] **Step 4: Check final length and pacing**

Target outcome:
- clearly larger than the original subsection
- roughly medium expansion in the spec target range of about 80–120 lines
- not chapter-dominating
- readable in one pass

### Task 4: Verify the final document change

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-tooling-section-design.md`

- [ ] **Step 1: Read back the final `1.2.2` subsection after editing**

Check for:
- structure completeness
- transitions between paragraphs
- accurate examples
- no broken Markdown formatting

- [ ] **Step 2: Compare the final subsection against the spec checklist**

Manually confirm all four required topics are present and clearly explained.

Checklist must also confirm:
- concrete content anchors were actually used in the prose
- the section follows the “结论先行，再解释机制/结构” form
- total size stays roughly within the 80–120 line target

- [ ] **Step 3: Summarize what changed for handoff**

Prepare a short summary covering:
- what was rewritten
- what themes were added
- how the subsection now relates to neighboring sections
