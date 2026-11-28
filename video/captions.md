<!--
  All the WORDING for cedar-act-sub-LAB's live Story (and any later video). Written from the lab's docs/talk-track.md:
  a sentence with no source there (measured / console text / UNVERIFIED / simulated) does not belong here.

  Rules for editing safely:
  - The first page has a "## Header" naming what the demo shows (rule 29): keep it on the Opening Slide.
  - Don't rename a "# Opening Slide" / "# Closing Slide" / "# Slide: <key>" / "# Step: <key>" heading, and don't rename
    a "## Header" / "## Title" / "## Text" / "## Lead" / "## Verdict" / "## Column A: ..." / "## Column B: ..." heading.
  - A "## Column A: <label>" or "## Column B: <label>" label IS shown on the slide as that column's heading.
  - Keep each bullet under a column on its own line starting with "- ".
  - "---" on its own line separates one section from the next.
  - No slide is held longer than 10 seconds (owner, 2026-11-22): keep each slide to about 40 words.
  - This repo is public: no host names, tenant ids, client ids or user names here.
  - Every run here is simulated (mock token, mock door); the measured card is the one measured content.
  - Live values go in {braces}, filled from the page by the Story wiring (storyWiring.js).
-->

# Opening Slide

## Header
Cedar act.sub: does the policy match the agent?

## Title
Cedar act.sub: does the policy match the agent?

## Lead
We measured Privilege's Cedar policy matching on the agent's act.sub claim on a real tenant; this lab replays the shape so you can see it.

## Column A: The setup
- One door, two tools
- Two Active act.sub policies
- One token, one agent

## Column B: The result
- The matching tool is allowed
- The other is refused
- Measured once, on 2026-11-16

## Verdict
Every run on this page is simulated; the door is an evaluator of one rule shape, not a Cedar engine, and it decides nothing real.

---

# Step: baseline_intro

## Title
Step 1: baseline

## Text
No policy on the door. The same token calls CountTool and ListIndexTool and both are allowed: sign-in is the only gate.

---

# Step: baseline_run

## Title
Run: no policy

## Text
Both tools served. This is the run every later step is compared against; only the policies change.

---

# Step: add_policies_intro

## Title
Step 2: add two Active act.sub policies

## Text
Read the Cedar: forbid the tool unless the token's claims have act.sub and it contains the agent. Policy A names the token's own agent; policy B names a different one. Only Active is enforced.

---

# Step: add_policies_run

## Title
Run: the policies are created

## Text
The policies go Active on the mock door. The token has not changed; what the policies name has.

---

# Step: same_token_intro

## Title
Step 3: same token, two tools

## Text
The token calls both tools again. The door checks each tool's policy against the token's act.sub: one names this agent, one does not.

---

# Step: same_token_run

## Title
Run: allowed and refused

## Text
CountTool is allowed; ListIndexTool is refused: "action denied by policy: ListIndexTool requires act.sub to be agent-b-example", JSON-RPC -32600. Open "What the mock door did (simulated)" to see the two checks the mock computed. It is the lab's mock, not Privilege.

---

# Step: remove_run

## Title
Step 4: remove the policies

## Text
Back to baseline: both tools served again. The policy was the only change.

---

# Step: act_text_run

## Title
Extra: act emitted as text

## Text
If act were emitted as the text "{}", the rule is believed to find no act.sub and so never to match (UNVERIFIED; act should be an object). All extras are simulated, none measured.

---

# Step: no_token_run

## Title
Extra: no token

## Text
With no token, this mock refuses at sign-in; the 401 wording is copied from the sibling lab, not measured.

---

# Step: candidate_run

## Title
Extra: Candidate state

## Text
Per the Privilege console documentation, a Candidate policy is stored and checked but not enforced (not re-run here, UNVERIFIED). Only Active is enforced.

---

# Step: measured

## Title
The measured card

## Text
This part is not a mock run: it is what happened on a real tenant on 2026-11-16. In one run the first poll, about 7 seconds after the policies were created, already showed the refusal. That is one observation, not a measured or guaranteed propagation time. Read the "Not measured" list aloud, then the UNVERIFIED claims card below it.

---

# Closing Slide

## Title
What this proved

## Lead
The measured run showed a Cedar act.sub policy refusing the tool whose policy names a different agent, and only that tool.

## Column A: Try next
- Re-run a step
- Read the UNVERIFIED card
- Run the real probe yourself

## Column B: Remember
- The mock decides nothing real
- Only Active is enforced
- One run, one tenant, one observation

## Verdict
Real is owner-only: `npm run real` in a terminal, against your own PingFederate and door.

---
