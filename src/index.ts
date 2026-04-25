import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// HELPER: Reliable SQL Save
	async saveMessage(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Save Error", e); }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE: D1 HISTORY LOADER ---
		if (url.pathname === "/api/history") {
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
			return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
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

				// IMMEDIATELY SAVE USER MSG
				await this.saveMessage(sessionId, 'user', userMsg);

				// --- 2. STATE MACHINE LOGIC ---
				const state = await this.ctx.storage.get("session_state");
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;

				// A. STATE: WAITING FOR ANSWER (A, B, or C)
				if (state === "WAITING_FOR_ANSWER" && activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER: ${userMsg}\nTASK: Grade the user. Facts: Courses start Aug 25, Thanksgiving Nov 25-29, Registrar (434) 982-5300. End by asking: "Would you like another question?"`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "UVA Tutor" }, { role: "user", content: graderPrompt }] });
					const gradeText = gradeRun.response || gradeRun;

					await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					await this.saveMessage(sessionId, 'assistant', gradeText);
					return new Response(`data: ${JSON.stringify({ response: gradeText })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: WAITING FOR CONTINUE (Yes/No)
				if (state === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("continue"))) {
					await this.ctx.storage.delete("session_state");
					return this.generateQuizQuestion(sessionId, userMsg); 
				}

				// --- 3. COMMANDS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nSay 'quiz question' to begin.";
					await this.saveMessage(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					return this.generateQuizQuestion(sessionId, userMsg);
				}

				// --- 4. STANDARD RAG ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Academic Calendar Aug 25 Nov 25";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: `You are Jolene. Ground all dates: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});
				const chatText = chatRun.response || chatRun;

				await this.saveMessage(sessionId, 'assistant', chatText);
				return new Response(`data: ${JSON.stringify({ response: chatText })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	// HELPER: Generate Grounded UVA Question
	async generateQuizQuestion(sessionId: string, userMsg: string): Promise<Response> {
		const facts = "UVA Facts: Courses begin Aug 25, 2026. Thanksgiving recess is Nov 25-29, 2026. Registrar Phone is (434) 982-5300. Spring Recess is March 6-14, 2027.";
		const prompt = `FACTS: ${facts}\nTASK: Generate ONE MCQ about these specific dates. Options A, B, C. Format: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown.`;
		
		const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
		let clean = (quizGen.response || quizGen).toString().replace("```json", "").replace("```", "").trim();
		const qData = JSON.parse(clean);
		
		await this.ctx.storage.put("active_quiz_question", qData); 
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

		const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
		await this.saveMessage(sessionId, 'assistant', uiRes);
		return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
