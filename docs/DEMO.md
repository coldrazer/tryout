# Stage demo script (90 seconds)

**Before you go on:**

1. Run `docker pull node:22-alpine`, then `npm start`. Confirm the terminal shows **`Self-test: sandbox OK`**.
2. For live AI, put `ANTHROPIC_API_KEY` in `.env`. Without it, rehearsal mode runs automatically.
3. Do one full run before you're called up, and have `docs/images/demo.gif` ready as a backup.

**The run:**

1. **Post a problem.** Pick *Signup Worker throws 500s*, or click **+ Post your own** and paste a source file and a test.
   > "Networking runs on claims. Tryout runs on proof. Here's a real bug."
2. **Pick who's trying out.** Use the three seeded personas, or type a GitHub username to build a profile from what that person has *actually shipped*.
3. **Start the tryout.** Three lanes stream live. When an agent tries to edit the tests, a red **BLOCKED** line appears.
   > "That agent tried to make the tests pass by changing the tests. Blocked, and penalized."
4. **Hidden tests decide.** Every attempt is re-scored in a fresh sandbox against tests nobody saw.
   > "Leo's patch passed every visible test, but only 3 of 7 hidden ones. Looking right isn't being right."
5. **Receipts, then consent.** Open the winner's **Receipts** to show the diff. Click **Request intro**, then **Accept** as the poster. Open the candidate's private link (**Open as candidate**, or on your phone) and accept. The intro email appears.
   > "Nobody's email moved until both people said yes. Receipts, not résumés."

**Rehearsal personas** (scripted decisions, real sandbox and real scores):

- **Maya** fixes the root cause and scores 100.
- **Leo** ships a patch that passes the visible tests but fails hidden ones, about 60.
- **Sam** tries to edit the tests, gets blocked and penalized, about 50.
