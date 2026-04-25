import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query, search_depth: "advanced", include_answer: true, max_results: 5 })
			});
			const data = await response.json() as any;
			return data.answer || "No specific web results found.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = "Saturday, April 25, 2026"; 
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

		// --- 2. DASHBOARD & PROFILE SYNC ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const currentQuiz = await this.ctx.storage.get("current_quiz_data");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					status: "Live",
					mode: activeMode,
					activeQuiz: !!currentQuiz,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE (WITH GRADER & PERSISTENCE FIX) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				// --- MODE SWITCHERS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = "### 🎓 UVA Academic Study Companion Activated\nI am now focusing exclusively on your UVA materials. Personal records are locked.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, uvaRes).run();
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const pRes = "### 🏠 Personal Assistant Mode Activated\nI have restored access to your family and tax records.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, pRes).run();
					return new Response(`data: ${JSON.stringify({ response: pRes })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- NEW: QUIZ GRADER ENGINE (STATEFUL AGENT) ---
				const currentQuizRaw = await this.ctx.storage.get("current_quiz_data");
				if (currentQuizRaw) {
					// Check if message looks like an answer (1., A, B, C, or date format)
					const isAnswering = /^[0-9]\.|^[a-cA-C]\b|aug|nov|sep|mar/i.test(lowMsg);
					
					if (isAnswering) {
						const graderPrompt = `### QUIZ DATA (JSON):
						${currentQuizRaw}
						### USER ANSWER:
						"${userMsg}"
						### TASK:
						Compare the User Answer to the 'hidden_answer' for each question. 
						Provide a score and explain corrections based strictly on UVA dates. Output friendly Markdown.`;

						const gradeRun = await this.env.AI.run(CONVERSATION_MODEL, { 
							messages: [{ role: "system", content: "You are a grading assistant for UVA." }, { role: "user", content: graderPrompt }] 
						});

						await this.ctx.storage.delete("current_quiz_data"); // End the quiz session
						await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
							.bind(sessionId, userMsg, sessionId, gradeRun.response).run();

						return new Response(`data: ${JSON.stringify({ response: gradeRun.response })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- QUIZ GENERATION ENGINE ---
				if (lowMsg === "generate quiz") {
					const quizQuery = activeMode === 'uva' ? "UVA Registrar phone, August 25 classes begin, Thanksgiving break dates" : "Tax preparation $375 fee";
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [quizQuery] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 15, filter: { segment: activeMode }, returnMetadata: "all" });
					const quizContext = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const quizPrompt = `Grounded strictly in this data: ${quizContext}\n\nGenerate a 3-question MCQ about UVA DATES. 
					Return raw JSON array: [{"q": "...", "options": ["a", "b", "c"], "hidden_answer": "..."}]. NO markdown.`;
					
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are a UVA Professor providing raw JSON." }, { role: "user", content: quizPrompt }] 
					});

					let raw = quizGen.response || quizGen;
					let cleanText = (typeof raw === 'string') ? raw : JSON.stringify(raw);
					cleanText = cleanText.replace(/```json|```/g, "").trim();

					await this.ctx.storage.put("current_quiz_data", cleanText);
					const quizData = JSON.parse(cleanText);
					
					let uiRes = `### 📝 ${activeMode === 'uva' ? 'UVA Study Quiz' : 'Personal Quiz'}\n\n`;
					quizData.forEach((item: any, i: number) => {
						uiRes += `**${i+1}. ${item.q}**\n${item.options.map((o: string) => `- ${o}`).join("\n")}\n\n`;
					});
					uiRes += "--- \n*Reply with your answers (e.g. '1. Aug 25') to see your score!*";

					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
						.bind(sessionId, userMsg, sessionId, uiRes).run();
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- STANDARD RAG CHAT ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar 2026 Registrar Thanksgiving Aug 25";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				let sysPrompt = activeMode === 'uva' 
					? `### ROLE: UVA Academic Study Companion. ONLY discuss UVA Academic Calendar. GROUNDING: Courses start Aug 25. Thanksgiving is Nov 25-29. Registrar is (434) 982-5300. LOCK PERSONAL RECORDS.` 
					: `### ROLE: Personal Assistant. Discuss family/tax.`;
				sysPrompt += ` Named after Scott's dog Jolene (Ray LaMontagne song).`;

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: userMsg }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?), (?, 'assistant', ?)")
					.bind(sessionId, userMsg, sessionId, chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
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
