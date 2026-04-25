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
		const today = "Friday, April 24, 2026"; 
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results }), { headers });
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
		}

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const currentQuiz = await this.ctx.storage.get("current_quiz_data");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results, 
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					status: "Live",
					mode: activeMode,
					activeQuiz: !!currentQuiz,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				await this.env.DOCUMENTS.put(file.name, await file.arrayBuffer(), { customMetadata: { segment: activeMode } });
				const text = await file.text();
				const chunks = text.match(/[\s\S]{1,1500}/g) || [];
				for (const chunk of chunks) {
					const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{ id: crypto.randomUUID(), values: embedding.data[0], metadata: { text: chunk, segment: activeMode, source: file.name } }]);
				}
				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaResponse = "### 🎓 UVA Academic Study Companion Activated\nI am now focusing exclusively on your CS 4750 materials and the UVA Academic Calendar. Personal records are now locked.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", uvaResponse).run();
					return new Response(`data: ${JSON.stringify({ response: uvaResponse })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const pResponse = "### 🏠 Personal Assistant Mode Activated\nI have restored access to your family and tax records.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", pResponse).run();
					return new Response(`data: ${JSON.stringify({ response: pResponse })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				if (lowMsg === "generate quiz" || lowMsg === "start quiz") {
					const quizQuery = activeMode === 'uva' ? "Fall 2026 start date, Thanksgiving recess, University Registrar phone" : "tax and family";
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [quizQuery] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
					const quizContext = quizMatches.matches.map(m => m.metadata.text).join("\n");

					const quizPrompt = `Generate a 3-question multiple-choice quiz based ONLY on: ${quizContext}. Output ONLY a raw JSON array: [{"q":"question","options":["a","b","c"],"hidden_answer":"a"}]. NO markdown code blocks.`;
					
					const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are a quiz data generator. Output ONLY raw JSON." }, { role: "user", content: quizPrompt }] 
					});

					let cleanJson = (quizGen.response || quizGen).toString().replace(/```json|```/g, "").trim();
					await this.ctx.storage.put("current_quiz_data", cleanJson);
					const quizData = JSON.parse(cleanJson);
					
					let uiRes = "### 📝 Knowledge Check\n\n";
					quizData.forEach((item: any, i: number) => {
						uiRes += `**${i+1}. ${item.q}**\n${item.options.map((o: string) => `- ${o}`).join("\n")}\n\n`;
					});
					uiRes += "--- \n*Reply with your answers!*";

					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", uiRes).run();
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins Cloudflare" : "UVA Syllabus Academic Calendar 2026";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				// CRITICAL PERSONA LOCK
				let sysPrompt = "";
				if (activeMode === 'uva') {
					sysPrompt = `### ROLE: UVA Academic Study Companion
- USER: Scott E Robbins.
- DATA: You ONLY have access to UVA Academic Calendar and CS 4750 files.
- GROUNDING: Courses begin Aug 25, 2026. Thanksgiving is Nov 25-29, 2026. Registrar is (434) 982-5300.
- RULE: DO NOT discuss tax, family, or marriage. If asked, say "I am in UVA Study Mode and cannot access personal records."
- NAME: Named after dog Jolene (Ray LaMontagne song).`;
				} else {
					sysPrompt = `### ROLE: Personal Assistant
- USER: Scott E Robbins.
- DATA: Access to tax records ($375 fee) and family (Wife Renee).
- NAME: Named after dog Jolene (Ray LaMontagne song).`;
				}

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: userMsg }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
					.bind(sessionId, "user", userMsg, sessionId, "assistant", chatRun.response).run();

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
