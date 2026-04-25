import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE FIX: MANDATORY D1 HISTORY LOAD ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
			const activeQuiz = await this.ctx.storage.get("active_quiz_question");

			return new Response(JSON.stringify({ 
				profile: "Scott E Robbins | Senior Solutions Engineer", 
				messageCount: stats?.total || 0,
				mode: activeMode,
				activeQuiz: !!activeQuiz,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// --- 2. TUTOR MODE: GRADER (RECOGNIZES BORDERLINE ANSWERS) ---
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;
				if (activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER: ${userMsg}\nTASK: Grade the user. Ground your explanation in UVA facts: Courses start Aug 25, Thanksgiving is Nov 25-29, Registrar phone is (434) 982-5300. Tell them to ask for another 'quiz question' to continue.`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "UVA Tutor" }, { role: "user", content: graderPrompt }] });
					const gradeText = gradeRun.response || gradeRun;

					await this.ctx.storage.delete("active_quiz_question");
					
					// SYNC TO D1 BEFORE RETURN
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, gradeText).run();

					return new Response(`data: ${JSON.stringify({ response: gradeText })}\n\ndata: [DONE]\n\n`);
				}

				// --- 3. MODE SWITCHERS (PERSISTENT) ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nAsk me for a 'quiz question' based on your calendar!";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, res).run();
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- 4. TUTOR MODE: GROUNDED GENERATION (FIXES HALLUCINATIONS) ---
				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar 2026 Fall classes begin August 25 Thanksgiving break November 25 Registrar phone (434) 982-5300"] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 5, filter: { segment: "uva" }, returnMetadata: "all" });
					const context = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const prompt = `CONTEXT: ${context}\nTASK: Generate ONE MCQ about UVA academic dates ONLY. Options A, B, C. Format: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown.`;
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
					
					let rawContent = quizGen.response || quizGen;
					let clean = typeof rawContent === 'string' ? rawContent.replace(/
http://googleusercontent.com/immersive_entry_chip/0

### 🧠 Why this reaches the "Final State" for your demo:
* **Persistence Synchronicity**: By placing the `INSERT INTO messages` SQL command inside every logic branch *before* the final response is returned, the Worker is forced to commit the chat history to the **D1 database** while it still has active execution time. This ensures that even if you refresh the browser mid-conversation, the messages will be waiting in the history loader.
* **Absolute Grounding**: The `quizVector` and system prompts are now hard-coded with the key document facts: **August 25** course start, **November 25-29** Thanksgiving recess, and the **(434) 982-5300** Registrar phone number. This prevents the AI from defaulting to its training data (like the capital of France) when generating study questions.
* **Safe Data Parsing**: The `typeof rawContent === 'string'` check prevents the "[object Object]" error by gracefully converting non-string AI outputs into a parsable JSON string before the `JSON.parse()` step.

**Deploy this, refresh your page, and follow this flow:**
1.  Type: *"Switch to UVA Mode"*
2.  Type: *"Jolene, give me a quiz question."*
3.  Answer with *"A"* (even if wrong) to see the **UVA Tutor** persona grade you.
4.  **Refresh** to prove the persistent chat history is fixed.
