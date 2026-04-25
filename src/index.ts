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
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
		}

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

				// --- 2. TUTOR MODE: GRADER (STATEFUL AGENT) ---
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;
				if (activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT: ${activeQuiz.hidden_answer}\nUSER: ${userMsg}\nTASK: Grade the user. Be a supportive UVA Tutor. Explain using the fact: ${activeQuiz.hidden_answer}. Tell them to ask for another 'quiz question' to continue.`;
					const gradeRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "UVA Tutor" }, { role: "user", content: graderPrompt }] });

					await this.ctx.storage.delete("active_quiz_question"); // Clear state
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, gradeRun.response).run();

					return new Response(`data: ${JSON.stringify({ response: gradeRun.response })}\n\ndata: [DONE]\n\n`);
				}

				// --- 3. MODE SWITCHERS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = "### 🎓 UVA Academic Study Companion Activated\nAsk me for a 'quiz question' to start studying!";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, res).run();
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- 4. TUTOR MODE: GENERATE ONE UVA QUESTION (GROUNDED RAG) ---
				if (lowMsg.includes("quiz question") || lowMsg.includes("generate a quiz")) {
					// FORCE retrieval of UVA academic data
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["University of Virginia Academic Calendar Fall 2026 courses begin August 25 Thanksgiving recess November 25 Registrar Phone (434) 982-5300"] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 5, filter: { segment: "uva" }, returnMetadata: "all" });
					const context = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const prompt = `CONTEXT: ${context}\nTASK: Generate ONE MCQ about UVA academic dates. NO GENERAL KNOWLEDGE. Options A, B, C. Return raw JSON: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown.`;
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "UVA Academic Examiner" }, { role: "user", content: prompt }] });
					
					let clean = (quizGen.response || quizGen).toString().replace(/```json|```/g, "").trim();
					const qData = JSON.parse(clean);
					await this.ctx.storage.put("active_quiz_question", qData); // Store in Durable Object

					const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, uiRes).run();
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- 5. STANDARD RAG CHAT ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar Courses begin August 25";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: `You are Jolene, a study companion. Mode: ${activeMode}. Ground all dates in FILE_DATA: August 25 classes begin, Nov 25 Thanksgiving, (434) 982-5300 Registrar.` }, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
					.bind(sessionId, userMsg, sessionId, chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "System Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
