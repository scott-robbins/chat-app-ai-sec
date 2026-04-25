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

		// --- 1. DASHBOARD & PROFILE ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				
				// Check for active quiz state in DO storage
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

		// --- 2. MEMORIZE (R2 Write & Vector Indexing) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				await this.env.DOCUMENTS.put(file.name, await file.arrayBuffer(), {
					customMetadata: { segment: activeMode }
				});

				const text = await file.text();
				const chunks = text.match(/[\s\S]{1,1500}/g) || [];
				
				for (const chunk of chunks) {
					const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{
						id: crypto.randomUUID(),
						values: embedding.data[0],
						metadata: { text: chunk, segment: activeMode, source: file.name }
					}]);
				}

				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase();

				// --- MODE SWITCHER GATES ---
				if (lowMsg.includes("switch to uva mode") || lowMsg.includes("activate uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaResponse = "### 🎓 UVA Mode Activated\nI am now your **UVA Academic Assistant**. I have locked away your personal files and am focusing exclusively on your CS 4750 Syllabus, UVA Academic Calendar, and academic needs.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", uvaResponse).run();
					return new Response(`data: ${JSON.stringify({ response: uvaResponse })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const personalResponse = "### 🏠 Personal Mode Activated\nI am back in **Personal Assistant** mode. I have restored access to your tax documents, family details, and dog namesake history.";
					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", personalResponse).run();
					return new Response(`data: ${JSON.stringify({ response: personalResponse })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- REFINED QUIZ ENGINE ---
				if (lowMsg === "generate quiz" || lowMsg === "start quiz") {
					// 1. Strict retrieval based on active mode
					const quizQuery = activeMode === 'uva' 
						? "UVA Academic Calendar dates, courses start, recess, registrar contact" 
						: "Tax organizer deadlines, base fees, and dog names";
					
					const quizVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [quizQuery] });
					const quizMatches = await this.env.VECTORIZE.query(quizVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
					const quizContext = quizMatches.matches.map(m => m.metadata.text).join("\n");

					// 2. Instruct LLM to generate questions but HIDE answers
					const quizPrompt = `### CONTEXT:
${quizContext}

### TASK:
Generate a 3-question multiple-choice quiz based ONLY on the provided context.
1. DO NOT include the correct answers in the visible response.
2. Return ONLY a JSON array: [{"q": "question", "options": ["a", "b", "c"], "hidden_answer": "correct option text"}].`;

					const quizGen = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "system", content: "You are an academic examiner. Output ONLY raw JSON." }, 
							{ role: "user", content: quizPrompt }
						]
					});

					// 3. Persist quiz data in Durable Object state
					await this.ctx.storage.put("current_quiz_data", quizGen.response);

					// 4. Format UI response (No answers shown)
					const quizData = JSON.parse(quizGen.response);
					let uiResponse = `### 📝 ${activeMode === 'uva' ? 'UVA Knowledge Check' : 'Personal Knowledge Check'}\n\n`;
					quizData.forEach((item: any, i: number) => {
						uiResponse += `**${i+1}. ${item.q}**\n${item.options.map((o: string) => `- ${o}`).join("\n")}\n\n`;
					});
					uiResponse += "--- \n**Reply with your answers to see how you did!**";

					await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
						.bind(sessionId, "user", userMsg, sessionId, "assistant", uiResponse).run();

					return new Response(`data: ${JSON.stringify({ response: uiResponse })}\n\ndata: [DONE]\n\n`);
				}

				// --- STANDARD RETRIEVAL & CHAT ---
				let webContext = "";
				if (["celtics", "76ers", "tonight", "weather", "sports", "date"].some(k => lowMsg.includes(k))) {
					webContext = await this.searchWeb(`${userMsg} ${today}`);
				}

				const retrievalKey = activeMode === 'personal' 
					? `Scott Robbins Cloudflare Senior Solutions Engineer Renee Bryana Callan Josie Jolene Hanna tax engagement` 
					: `UVA CS 4750 Syllabus Academic Calendar Courses Fall 2026 Spring 2027 Thanksgiving Recess Registrar Contact Info`;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 50, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");

				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				let sysPrompt = "";
				if (activeMode === 'uva') {
					sysPrompt = `### IDENTITY: UVA ACADEMIC ASSISTANT
- USER: Scott E Robbins (Senior Solutions Engineer at Cloudflare).
- YOUR ROLE: You are Jolene, a professional academic aide for the University of Virginia.
- **GROUNDING RULE**: You MUST use RETRIEVED_FILE_DATA for all dates and contact info.
- ACCESS RULE: Only discuss CS 4750 Syllabus and Academic Calendar info. 
- DATA RESTRICTION: Do NOT discuss Scott's tax returns or family. State they are locked in Personal Mode.
- NAMING: Named after Scott's dog, who was named after the Ray LaMontagne song.`;
				} else {
					sysPrompt = `### IDENTITY: PERSONAL ASSISTANT
- USER: Scott E Robbins (Senior Solutions Engineer at Cloudflare). 
- YOUR ROLE: You are Scott's personal assistant.
- FAMILY & PETS: Wife Renee, Daughter Bryana, Grandkids Callan & Josie, Dogs Jolene & Hanna.
- LORE: You are named after the dog Jolene (Ray LaMontagne song).
- TAX DATA: Access to the Cozby CPA letter ($375 fee, March 13 deadline).`;
				}

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: userMsg }] 
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?), (?, ?, ?)")
					.bind(sessionId, "user", userMsg, sessionId, "assistant", chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
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
