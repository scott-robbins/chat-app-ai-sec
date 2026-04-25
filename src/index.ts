import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE: D1 HISTORY LOADER ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		// --- 2. COMMAND CENTER SYNC (FULL HISTORY RESTORED) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results || [],
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE (WITH HARDENED GRADER) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// Save User Input
				await this.saveMsg(sessionId, 'user', userMsg);

				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;

				// A. STATE: GRADING THE ANSWER (FIXED TO REMOVE 0/1 ERRORS)
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const userLetter = lowMsg[0].toUpperCase();
					const correctLetter = currentQ.hidden_answer.toUpperCase();
					
					// Map index for correct answer text
					const correctIdx = correctLetter.charCodeAt(0) - 65;
					const correctText = currentQ.options[correctIdx];

					const graderPrompt = `QUESTION: ${currentQ.q}
					USER ANSWER: ${userLetter}
					CORRECT LETTER: ${correctLetter}
					CORRECT FACT TEXT: ${correctText}

					TASK: Tell the user if they were correct.
					CRITICAL: Always refer to the answer by its LETTER (A, B, or C). 
					Do NOT mention indices like "0" or "1".
					Explain the fact: "${correctText}".
					Ask "Ready for question ${index + 2}?" if questions remain.`;
					
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are the UVA Academic Tutor. Ground every grade in the provided FACT TEXT." }, { role: "user", content: graderPrompt }] 
					});
					const gradeTxt = gradeRun.response || gradeRun;

					if (index + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.ctx.storage.delete("current_q_idx");
					}

					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING "CONTINUE"
				if (sessionState === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("ready") || lowMsg.includes("next"))) {
					const nextQ = pool[index];
					await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
					
					const optionsLines = nextQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
					const uiRes = `### 📝 Question ${index + 1} of 5\n**${nextQ.q}**\n\n${optionsLines}\n\n*Reply A, B, or C!*`;
					
					await this.saveMsg(sessionId, 'assistant', uiRes);
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- COMMANDS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = "### 🎓 UVA Academic Study Companion Activated\nSay 'start a quiz' to begin your 5-question study session.";
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz")) {
					return this.initQuizPool(sessionId);
				}

				// --- STANDARD RAG ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax Scott Robbins" : "UVA Academic Calendar August 25 Registrar";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `Identity: Jolene. Mode: ${activeMode}. Ground all dates: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, 
						{ role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }
					] 
				});
				const chatTxt = chatRun.response || chatRun;

				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				const err = "System Error: " + e.message;
				await this.saveMsg(sessionId, 'assistant', err);
				return new Response(`data: ${JSON.stringify({ response: err })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: 1. Fall 2026 courses begin Aug 25. 2. Thanksgiving recess is Nov 25-29. 3. Registrar phone is (434) 982-5300. 4. UVA was founded in 1819. 5. First classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate EXACTLY 5 MCQ questions. Return a raw JSON array ONLY: [{"q":"Question Text","options":["Option 1","Option 2","Option 3"],"hidden_answer":"A"}].`;
			
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are a JSON-only API." }, { role: "user", content: prompt }] });
			let raw = typeof quizGen.response === 'string' ? quizGen.response : JSON.stringify(quizGen.response || quizGen);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); 
			if (!jsonMatch) throw new Error("AI failed to build question pool.");
			
			const pool = JSON.parse(jsonMatch[0]);
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const firstQ = pool[0];
			const optionsText = firstQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
			const uiRes = `### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${optionsText}\n\n*Reply with A, B, or C!*`;
			
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) {
			return new Response(`data: ${JSON.stringify({ response: "Quiz Pool Error: " + e.message })}\n\ndata: [DONE]\n\n`);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
