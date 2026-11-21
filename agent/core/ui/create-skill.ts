// SPDX-License-Identifier: AGPL-3.0-or-later
// Sourced from plugin/src/ui/create-skill.ts in 54yyyu/zotero-mcp. See THIRD_PARTY_NOTICES.md.
// The built-in create-skill skill. The host writes it into the agent's folder with SKILLS_DIR filled in, so the agent
// knows where the user's skills live even when it picks the skill up by itself (Claude and Codex list workspace skills).

export const SKILLS_DIR_MARK = "{{SKILLS_DIR}}";

export const CREATE_SKILL_MD = `---
name: create-skill
description: Write a new skill for DioSidecar with the user - a SKILL.md of plain, numbered instructions the agent follows using drawio-canvas MCP tools. Use when the user asks to create, make or write a skill, or types /create-skill.
---

# Create a skill

A skill is a folder with one \`SKILL.md\`: a frontmatter with \`name\` and \`description\`, then plain instructions.
The agent operates on the live draw.io canvas through the \`drawio-canvas\` MCP tools. The user's skills live in

    ${SKILLS_DIR_MARK}

The panel lists every folder there. Save new skills only there.

## 1. Interview, briefly

Ask in one message, and skip what the user already said:

1. What diagramming task, and on what (the current page, selected shapes, or a new diagram)?
2. What should the result look like (layout direction, node styles, palette, Mermaid vs. XML)?
3. Rules: colors, typography, naming conventions, spacing, or verification checks.
4. One example of a good result, if they have one.

## 2. Use the available drawio-canvas MCP tools

Stick to the tools exposed by \`drawio-canvas\` (\`get_diagram_summary\`, \`get_cells_detail\`, \`search_shapes\`, \`get_drawio_reference\`, \`inspect_canvas_image\`, \`update_cells\`, \`insert_xml\`, \`insert_mermaid\`, \`delete_cells\`, \`select_and_focus\`).

## 3. Skill or prompt?

If it fits in one or two sentences with no multi-step rules or checks ("Make selected boxes blue and aligned"), it is better
as a prompt. Say so, give the text in a code block, and tell the user to add it under Settings > Skills and prompts >
New prompt. Write no file.

## 4. Write SKILL.md

- \`name\`: lowercase words joined by hyphens, at most 64 characters, not already a folder above.
- \`description\`: one sentence on what it does and when to use it, with the words a user would say ("clean-architecture",
  "aws-diagram"). The description decides when the skill is picked, so make it specific.
- Body: a one-line goal; the user's rules (colors, layout, style conventions) as a small table near the top, easy to change;
  then numbered steps. End with Gotchas if there are any.
- Plain words, no filler, under about 150 lines.

Save it as \`${SKILLS_DIR_MARK}/<name>/SKILL.md\` (make the folder). Never overwrite an existing skill without asking.

## 5. Suggest a test

Suggest trying it on a diagram: open a canvas, type \`/<name>\` in the panel. Offer to adjust the skill after that first run.
`;

export const createSkillText = (skillsDir: string): string => CREATE_SKILL_MD.split(SKILLS_DIR_MARK).join(skillsDir);
