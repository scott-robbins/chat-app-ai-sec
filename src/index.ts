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

		// --- 1. PERSISTENCE: D1 SQL HISTORY LOADER ---
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

		// --- 2. DASHBOARD SYNC ---
		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
			const storage = await this.env.DOCUMENTS.list();
			const activeQuiz = await this.ctx.storage.get("active_quiz_question");

			return new Response(JSON.stringify({ 
				profile: "Scott E Robbins | Senior Solutions Engineer", 
				messageCount: stats?.total || 0,
				knowledgeAssets: storage.objects.map(o => o.key), 
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

				// --- STEP A: SAVE USER MESSAGE TO D1 IMMEDIATELY ---
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)")
					.bind(sessionId, userMsg).run();

				// --- 3. TUTOR MODE: GRADER ---
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;
				if (activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER_ANSWER: ${userMsg}\nTASK: Grade the user. Ground your explanation in UVA facts: Courses start Aug 25, Thanksgiving is Nov 25-29, Registrar phone is (434) 982-5300. Tell them to ask for another 'quiz question' to continue.`;
					
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are a UVA Study Companion." }, { role: "user", content: graderPrompt }] });
					const gradeText = gradeRun.response || gradeRun;

					await this.ctx.storage.delete("active_quiz_question");
					
					// SAVE ASSISTANT RESPONSE
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
						.bind(sessionId, gradeText).run();

					return new Response(`data: ${JSON.stringify({ response: gradeText })}\n\ndata: [DONE]\n\n`);
				}

				// --- 4. MODE SWITCHERS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nAsk me for a 'quiz question' to start studying!";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
						.bind(sessionId, res).run();
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = "### 🏠 Personal Assistant Mode Activated";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
						.bind(sessionId, res).run();
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- 5. TUTOR MODE: GROUNDED GENERATION ---
				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar 2026 Fall classes begin August 25 Thanksgiving break November 25 Registrar phone (434) 982-5300"] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 5, filter: { segment: "uva" }, returnMetadata: "all" });
					const context = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const prompt = `CONTEXT: ${context}\nTASK: Generate ONE MCQ about UVA academic dates ONLY. Options A, B, C. Format: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown. No intro.`;
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are a JSON-only Academic API." }, { role: "user", content: prompt }] });
					
					let rawContent = quizGen.response || quizGen;
					let clean = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
					// Safe cleanup without breaking regex
					clean = clean.replace("```json", "").replace("```", "").trim();
					
					const qData = JSON.parse(clean);
					await this.ctx.storage.put("active_quiz_question", qData); 

					const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
						.bind(sessionId, uiRes).run();
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- 6. STANDARD RAG ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins Cloudflare" : "UVA Syllabus Academic Calendar Courses begin August 25";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: `Identity: Jolene. Mode: ${activeMode}. Ground all dates: Aug 25 start, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});
				const chatText = chatRun.response || chatRun;

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)")
					.bind(sessionId, chatText).run();

				return new Response(`data: ${JSON.stringify({ response: chatText })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "System Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
