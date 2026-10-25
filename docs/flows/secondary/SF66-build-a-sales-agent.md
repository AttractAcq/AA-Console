# SF66 — Build a sales agent

**Where.** Clients → [client] → Delivery → Sales OS (v2) → Agents
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF12.

## Do it
1. **Brief the sales agent**:
   - **Agent name**
   - **What this agent is for**
   - **What surface is this agent for**
   - **Anything to steer it (optional)**
2. Choose the role:

| Role | Job |
|---|---|
| **Appointment setter** | Books calls. The flagship journey's choice |
| **Inbound qualifier** | Works out whether an enquiry is a fit |
| **Closer assist** | Helps a human close |
| **Nurture** | Keeps a conversation warm |
| **Reactivation** | Re-opens a lapsed customer |

3. **Build Sales Agent** → *"Queued. The builder is writing the agent now."*
   Until it finishes it reads *"Waiting for the builder to write this."*

## Read everything it wrote
The builder produces the greeting, system prompt, qualification, objections,
**booking rule**, escalation rule and guardrails. Read all of it. The two that matter most:

- **Qualification** — what makes someone a fit. Too loose and the client's diary fills with
  time-wasters; too tight and it turns away business.
- **Guardrails** — what the agent must never say or promise. This is what stops it committing
  the client to a price, a date or a result they cannot deliver.

## It refuses to cite uncleared proof
Deliberately. That is not a bug to work around (SF25).

## Next
SF67 to approve and deploy it.
