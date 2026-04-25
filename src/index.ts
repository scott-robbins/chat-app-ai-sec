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

		// --- 1. PERSISTENCE FIX: RELIABLE HISTORY LOADER ---
		if (url.pathname === "/api/history") {
			const history = await this.env.jolene_db.prepare(
				"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50"
			).bind(sessionId).all();
			return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
			const storage = await this.env.DOCUMENTS.list();
			const currentQuiz = await this.ctx.storage.get("active_quiz_question");

			return new Response(JSON.stringify({ 
				profile: "Scott E Robbins | Senior Solutions Engineer", 
				messageCount: stats?.total || 0,
				knowledgeAssets: storage.objects.map(o => o.key), 
				mode: activeMode,
				activeQuiz: !!currentQuiz,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// --- 2. TUTOR MODE: SINGLE QUESTION GRADER ---
				const activeQuiz = await this.ctx.storage.get("active_quiz_question") as any;
				if (activeQuiz && /^[a-c]$/i.test(lowMsg)) {
					const graderPrompt = `QUESTION: ${activeQuiz.q}\nCORRECT ANSWER: ${activeQuiz.hidden_answer}\nUSER ANSWER: ${userMsg}\nTASK: Tell the user if they were right. Provide a 1-sentence UVA-fact-based explanation. Then say "Ask for another question to keep going!"`;
					
					const gradeRun = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are a UVA Tutor." }, { role: "user", content: graderPrompt }] 
					});

					await this.ctx.storage.delete("active_quiz_question"); // Clear state
					
					// SAVE TO D1 IMMEDIATELY
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

				// --- 4. TUTOR MODE: GENERATE ONE QUESTION ---
				if (lowMsg.includes("quiz question") || lowMsg.includes("generate question")) {
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar dates registrar contact"] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 5, filter: { segment: "uva" }, returnMetadata: "all" });
					const context = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const prompt = `Based on: ${context}\nGenerate ONE MCQ. Options A, B, C. Return raw JSON: {"q":"...","options":["A...","B...","C..."],"hidden_answer":"A"}. No markdown.`;
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
					
					let clean = (quizGen.response || quizGen).toString().replace(/```json|```/g, "").trim();
					const qData = JSON.parse(clean);
					await this.ctx.storage.put("active_quiz_question", qData); // Store one question

					const uiRes = `### 📝 Study Question\n**${qData.q}**\n${qData.options.join("\n")}\n\n*Reply with A, B, or C!*`;
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, uiRes).run();
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- 5. STANDARD RAG ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: `You are Jolene. Mode: ${activeMode}. Ground all dates in FILE_DATA.` }, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
					.bind(sessionId, userMsg, sessionId, chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
