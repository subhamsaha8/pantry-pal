# Devpost submission draft: Pantry Pal

**Track:** Alexa+ (self-hosted MCP server, Streamable HTTP, spec 2025-11-25)
**Mini challenges:** Open Source (MIT-licensed repo). AWS Builder only if you deploy on AWS and document it; see below.

## Project description (paste into Devpost)

Pantry Pal is a self-hosted MCP server that gives Alexa+ a memory for your kitchen. Tell Alexa what you bought and when it expires; later ask "what should I eat first?" or "what can I cook?" and it answers using what's actually in your pantry, favouring ingredients that are about to go off. When you use up the last onion it offers to add it to your shopping list, and buying it again takes it off.

It implements the Model Context Protocol over Streamable HTTP (spec 2025-11-25) with six tools: `add_item`, `list_pantry`, `expiring_soon`, `use_item`, `suggest_meals`, `shopping_list`. Each tool returns a short sentence written to be spoken aloud plus `structuredContent` for richer clients. It validates input (errors come back as `isError` results so the model can ask a follow-up), enforces transport rules (protocol-version header, Origin checks, session handling, no batching), supports optional bearer auth, and has zero dependencies, so it runs anywhere Node 18+ does. 16 end-to-end tests exercise the live HTTP endpoint.

Impact: household food waste is large and mostly a logging problem; voice removes the friction of logging.

## What was built during the hackathon

Everything: this is a new project.

## Product feedback (starter notes, edit with your real experience)

- **Used:** MCP Streamable HTTP, spec 2025-11-25, as the integration surface for Alexa+.
- **Worked well:** MCP is a small, well-specified protocol; a compliant server fits in one file, and tool annotations plus `isError` semantics map naturally onto voice flows.
- **Needs work / friction:** *(fill in from your Alexa+ onboarding: how you registered the server, auth options, how to test without a device, error visibility.)*
- **Would build again:** yes.

## Friction log entry (optional, up to +10% bonus)

- **Task:** Install the official MCP TypeScript SDK to build the server.
- **Steps:** `npm install @modelcontextprotocol/sdk express zod`.
- **Expected / actual:** Expected a normal install; got `403 Forbidden` from the package registry in my build environment (an environment policy, not an SDK problem).
- **Severity:** Low. 
- **Workaround:** Implemented the protocol directly with Node built-ins.
- **Suggestion:** Publish a minimal protocol reference plus a conformance test suite so dependency-free servers can prove compliance.

## Before you submit: checklist

- [ ] Record a <3 min demo (YouTube/Vimeo, public, English). Suggested script: add eggs expiring in 2 days → "what should I eat first?" → "what can I cook?" → use the last onion → shopping list. Show the Alexa+ interaction, or the MCP Inspector if you can't get Alexa+ Preview access.
- [ ] Deploy over public HTTPS (see README) and show it working in the demo.
- [ ] Push to GitHub. Either keep it **public** with the MIT `LICENSE` (needed for the Open Source challenge), or make it **private** and add `testing@devpost.com` plus the Amazon reviewers as collaborators: `chris-trag`, `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar`. Each must accept the invite and invites expire after 7 days, so add them at submission time.
- [ ] Open Source challenge extras: contribution URL, repo URL, your GitHub username, short description.
- [ ] AWS Builder (optional): deploy on AWS (e.g. App Runner/ECS behind ALB, or Lambda + API Gateway) and describe the services in your feedback answer.
