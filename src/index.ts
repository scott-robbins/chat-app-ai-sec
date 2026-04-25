import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE SQL PERSISTENCE ---
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
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		// --- 2. COMMAND CENTER SYNC (RESTORED HISTORY FETCH) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				
				// CRITICAL FIX: Fetch history so the UI can reload it on refresh
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				
				const storage = await this.env.DOCUMENTS.list();
				const activeQuiz = await this.ctx.storage.get("active_quiz_question");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results || [], // RESTORED
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					mode: activeMode,
					activeQuiz: !!activeQuiz,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT & TUTOR ENGINE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// --- IMMEDIATE PERSISTENCE (SAVE USER MESSAGE) ---
				await this.saveMsg(sessionId, 'user', userMsg);

				// --- TUTOR STATE MACHINE ---
				const sessionState = await this.ctx.storage.get("session_state");
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;

				// A. STATE: GRADING THE ANSWER
				if (sessionState === "WAITING_FOR_ANSWER" && activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER: ${userMsg}\nTASK: Grade the user. Be the UVA Academic Study Companion. Facts: Courses start Aug 25, Thanksgiving Nov 25-29, Registrar (434) 982-5300. End with "Would you like another question?"`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are the UVA Study Companion Tutor." }, { role: "user", content: graderPrompt }] 
					});
					const gradeTxt = gradeRun.response || gradeRun;

					await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING "YES/CONTINUE"
				if (sessionState === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("next") || lowMsg.includes("continue"))) {
					return this.generateQuizQuestion(sessionId); 
				}

				// --- COMMANDS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nAsk me for a 'quiz question' to start studying!";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = "### 🏠 Personal Assistant Mode Activated";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					return this.generateQuizQuestion(sessionId);
				}

				// --- STANDARD RAG CHAT ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Academic Calendar August 25 Registrar phone (434) 982-5300";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Mode: ${activeMode}. Ground dates in: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, 
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

	// --- HELPER: GENERATE GROUNDED UVA QUESTION ---
	async generateQuizQuestion(sessionId: string): Promise<Response> {
		try {
			const facts = "UVA Academic Calendar 2026: Courses begin Aug 25. Thanksgiving recess Nov 25-29. Registrar (434) 982-5300. Spring Recess March 6-14, 2027.";
			const prompt = `FACTS: ${facts}\nGenerate ONE MCQ about UVA academic dates. Options A, B, C. Return raw JSON ONLY: {"q":"...","options":["A. ...","B. ...","C. ..."],"hidden_answer":"A"}. No markdown. No intro.`;
			
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
			
			// --- ULTIMATE SAFE PARSER (FIX FOR raw.match ERROR) ---
			const rawContent = quizGen.response || quizGen;
			const raw = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);

			const jsonMatch = raw.match(/\{[\s\S]*\}/);
			if (!jsonMatch) throw new Error("AI failed to provide valid JSON.");
			
			const qData = JSON.parse(jsonMatch[0]);
			
			// STATE LOCK
			await this.ctx.storage.put("active_quiz_question", qData); 
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) {
			const err = "Quiz Error: " + e.message;
			return new Response(`data: ${JSON.stringify({ response: err })}\n\ndata: [DONE]\n\n`);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
