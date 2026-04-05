# MCP and Skill Sections Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite sections `1.2.3 MCP：工具体系的无限扩展口` and `1.2.4 Skill 系统：把工作流固化成命令` in `docs/claude_code_arch.md` so both become short, symmetric analysis-report sections that explain architectural role, mechanism, boundaries, and why they matter.

**Architecture:** Treat this as a focused documentation refactor within a single Markdown file. Keep both sections parallel in shape and density: each should move from definition to architectural role, then to execution/integration mechanism, then to boundary with the other section, and finally to a concise conclusion. Preserve continuity with the newly rewritten `1.2.2` and avoid swallowing `1.2.5` or later chapters.

**Tech Stack:** Markdown documentation, existing prose style in `docs/claude_code_arch.md`, spec at `docs/superpowers/specs/2026-04-01-mcp-skill-sections-design.md`.

---

### Task 1: Reconfirm constraints and map the exact edit surface

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-mcp-skill-sections-design.md`

- [ ] **Step 1: Re-read `1.2.3`, `1.2.4`, and their neighbors**

Read:
- the end of `1.2.2`
- all of `1.2.3`
- all of `1.2.4`
- the start of `1.2.5`

Goal: preserve local rhythm and ensure the two rewritten sections bridge cleanly between tool system discussion and context management.

- [ ] **Step 2: Extract the non-negotiable content requirements from the spec**

Confirm that the final rewrite must:
- strengthen both MCP and Skill, not just one of them
- keep them short and symmetric
- treat MCP as the external-system expansion interface
- treat Skill as the internal-workflow consolidation layer
- explain boundaries relative to each other and nearby chapters

- [ ] **Step 3: Lock the parallel section shape before editing**

Use the same high-level pattern for both sections:
1. opening architectural judgment
2. role in the overall system
3. mechanism/integration details
4. boundary against the sibling section
5. closing synthesis

- [ ] **Step 4: Scope guard the file edit**

Confirm:
- only `1.2.3` and `1.2.4` will be rewritten
- surrounding section titles and anchors stay unchanged
- both sections should end up with similar visual weight on the page
- each section should land roughly in the spec target range of about 45–70 lines of Markdown prose/block content

### Task 2: Rewrite `1.2.3 MCP` as an architectural interface section

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-mcp-skill-sections-design.md`

- [ ] **Step 1: Replace the current opening with an architectural thesis**

The opening of `1.2.3` should establish that MCP is not just “third-party tools support,” but the layer that converts external systems into capabilities Claude Code can schedule through the same runtime surface as built-in tools.

Expected outcome: the first paragraph reads like a judgment about architecture, not a feature note.

- [ ] **Step 2: Add a paragraph defining MCP’s role in the whole system**

Make sure the section explains:
- MCP is not one tool, but a protocol/integration layer
- it extends the runtime capability surface beyond built-in tools
- it matters because enterprise environments always have proprietary systems the shipped toolset cannot cover

Expected outcome: readers understand why MCP belongs in the architecture chapter.

- [ ] **Step 3: Expand the transport-mechanism explanation**

Keep and expand the existing five-line transport block currently under `1.2.3`:
- `Stdio`
- `SSE`
- `WebSocket`
- `HTTP`
- `SDK Control`

But add one sentence of purpose for each class of connection so the section explains why multiple protocols exist instead of only listing them.

- [ ] **Step 4: Add the authentication and security angle**

Explicitly retain or mention:
- OAuth 2.0
- PKCE
- token refresh
- `X-MCP-Scope`

Expected outcome: readers see that the design is meant for real enterprise service integration, not hobby-only extension.

- [ ] **Step 5: Clarify dynamic loading and runtime consequences**

Explain that MCP server definitions are discovered at runtime, loaded into the tool surface, and then become effectively first-class callable capabilities from the model’s point of view.

Expected outcome: the section makes clear that the practical tool limit is no longer just what ships in the binary.

- [ ] **Step 6: Add a short MCP-vs-Skill boundary sentence**

The section should end or near-end with a clean distinction:
- MCP extends external capability boundaries
- Skill standardizes internal workflow boundaries

- [ ] **Step 7: Close `1.2.3` with a concise synthesis**

The closing should summarize why MCP is the interface that lets Claude Code enter real-world environments with heterogeneous services.

### Task 3: Rewrite `1.2.4 Skill` as a workflow-asset section

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-mcp-skill-sections-design.md`

- [ ] **Step 1: Replace the current opening with a stronger architectural judgment**

The opening of `1.2.4` should establish that Skill is not merely a convenience shortcut for prompts, but a way to solidify repeated team workflows, constraints, and review standards into reusable assets.

Expected outcome: the section opens at the same analytical level as `1.2.3`.

- [ ] **Step 2: Add a paragraph defining Skill’s role in the whole system**

Make sure the section explains:
- Skill is about internal method, not external system integration
- it reduces repeated instruction cost for high-frequency tasks
- it turns recurring processes into stable entry points

Expected outcome: readers understand why Skill belongs beside MCP rather than as a minor convenience feature.

- [ ] **Step 3: Expand the execution mechanism**

Retain the existing `settings.json` skill example block currently under `1.2.4`, then make the chain explicit:
- define skill in config
- `SkillTool` resolves the skill
- file-based skill injects content into context
- command-based skill executes the mapped command
- the active task starts from a pre-shaped workflow context

Expected outcome: readers see how Skill changes the AI’s starting conditions, not just its wording.

- [ ] **Step 4: Add a section on maintainability and organizational memory**

Cover the concrete advantages that make Skill symmetrical with MCP in importance:
- can live in team/project config over time
- can encode review checklists, delivery conventions, naming rules, and routine procedures
- reduces process drift between people and sessions
- moves know-how from individual memory into system-maintained workflow assets

Expected outcome: Skill no longer reads like a glorified command alias.

- [ ] **Step 5: Add the “why it is stronger than a prompt template” paragraph**

Explain the difference between:
- static prompt template text
- reusable workflow unit with entry point, constraints, and repeatable team semantics

Expected outcome: readers understand why Skill is an architectural mechanism, not just prompt sugar.

- [ ] **Step 6: Add a short Skill-vs-MCP boundary sentence**

The section should clearly distinguish:
- MCP = connect outside systems
- Skill = standardize inside workflows

- [ ] **Step 7: Close `1.2.4` with a concise synthesis**

The closing should summarize why Skill lets Claude Code work in a team’s established way rather than forcing users to restate process on every task.

### Task 4: Rebalance both sections so they stay short and symmetric

**Files:**
- Modify: `docs/claude_code_arch.md`

- [ ] **Step 1: Compare the visual and conceptual weight of both sections**

Check:
- similar density
- similar number of idea blocks
- neither section feeling like a miniature chapter while the other is a note

- [ ] **Step 2: Trim or expand as needed to restore symmetry**

Target outcome:
- both sections clearly stronger than before
- both still shorter than `1.2.5`
- both feel intentionally paired
- each section remains roughly within the 45–70 line target so “short and symmetric” is visible on the page

- [ ] **Step 3: Verify boundary discipline**

Confirm:
- `1.2.3` does not re-explain the whole tool system from `1.2.2`
- `1.2.4` does not drift into full context management or task system discussion
- `1.2.4` does not absorb the `1.2.6 任务系统` discussion beyond brief references to workflow reuse or process structure
- neither section absorbs `1.3.4 多 Agent 协调`

### Task 5: Final verification and handoff summary

**Files:**
- Modify: `docs/claude_code_arch.md`
- Reference: `docs/superpowers/specs/2026-04-01-mcp-skill-sections-design.md`

- [ ] **Step 1: Re-read the final `1.2.3` and `1.2.4` text**

Check for:
- natural transitions
- analysis-report tone
- no broken Markdown
- correct use of examples and configuration snippets

- [ ] **Step 2: Compare the rewritten sections against the spec**

Manually confirm that both sections now cover:
- architectural role
- mechanism details
- mutual boundary
- short symmetric shape

Verification checklist must also confirm:
- each section is roughly within the 45–70 line target
- the five transport modes block under `1.2.3` was preserved and strengthened rather than dropped
- the existing `settings.json` skill example under `1.2.4` was preserved and better integrated into the explanation
- `1.2.6 任务系统` remains a separate topic and was not folded into the Skill section

- [ ] **Step 3: Prepare a concise summary for the user**

Summarize:
- what changed in `1.2.3`
- what changed in `1.2.4`
- how the two sections now relate to `1.2.2`
