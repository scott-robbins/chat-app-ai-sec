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

		// --- 1. PERSISTENCE FIX: D1 SQL LOADER ---
		if (url.pathname === "/api/history") {
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
			return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
		}

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

				// --- QUIZ ENGINE: STRICT CONTENT LOCK ---
				if (lowMsg === "generate quiz") {
					const quizQuery = activeMode === 'uva' ? "UVA Registrar phone, August 25 classes begin, Thanksgiving break dates" : "Tax preparation $375 fee";
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [quizQuery] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 15, filter: { segment: activeMode }, returnMetadata: "all" });
					const quizContext = quizMatches.matches.map(m => m.metadata.text).join("\n");

					// PROMPT RE-ORDERED TO PREVENT FORMATTING HALLUCINATIONS
					const quizPrompt = `Grounded strictly in this data: ${quizContext}\n\nGenerate a 3-question Multiple Choice Quiz about UVA DATES and CONTACT INFO. 
					FORMAT REQUIREMENT: Output raw JSON array ONLY. 
					STRUCTURE: [{"q": "Question Text", "options": ["a", "b", "c"], "hidden_answer": "correct option"}].
					CRITICAL: Do NOT quiz the user about JSON or technology. Quiz them about UVA academic dates.`;
					
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are a UVA Professor. You provide quiz data in JSON format only." }, { role: "user", content: quizPrompt }] 
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
					uiRes += "--- \n*Reply with your answers!*";

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
					? `### ROLE: UVA Academic Study Companion. ONLY discuss UVA Academic Calendar data. 
					   GROUNDING: Courses start Aug 25. Thanksgiving is Nov 25-29. Registrar is (434) 982-5300.
					   LOCK: Refuse all family/tax/job questions.` 
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
