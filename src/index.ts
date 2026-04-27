import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
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

	// --- HELPER: UNIVERSAL AI BROKER (STRICT ROLE ALTERNATION) ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) {
					chatMessages.push(msg);
				}
			}
		}

		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		if (model.startsWith("@cf/")) {
			const run: any = await this.env.AI.run(model as any, { 
				messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
			});
			return run.response || run;
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

		if (model.includes("gpt")) {
			const res = await fetch(`${gatewayBase}/openai/chat/completions`, {
				method: "POST",
				headers: { "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] })
			});
			const data: any = await res.json();
			if (data.error) throw new Error(data.error.message);
			return data.choices[0].message.content;
		}

		if (model.includes("claude")) {
			const res = await fetch(`${gatewayBase}/anthropic/messages`, {
				method: "POST",
				headers: { "x-api-key": this.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
				body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages: chatMessages })
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`Claude Error: ${data.error.message || JSON.stringify(data.error)}`);
			return data.content[0].text;
		}
		throw new Error(`Model ${model} not supported.`);
	}

	async tavilySearch(query: string) {
		try {
			const response = await fetch('[https://api.tavily.com/search](https://api.tavily.com/search)', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY || "",
					query: `${query} current status 2026`,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) { return "Web search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

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
			} catch (e: any) { 
				return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); 
			}
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				// --- 1. GLOBAL STOP QUIZ HANDLER ---
				if (lowMsg.includes("stop quiz")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					await this.ctx.storage.delete("current_q_idx");
					await this.ctx.storage.delete("quiz_score");
					const stopRes = "### 🛑 Quiz Session Ended\nI have stopped the current quiz and reset your learning state. What would you like to discuss next?";
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', stopRes);
					return new Response(`data: ${JSON.stringify({ response: stopRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- 2. QUIZ STATE MACHINE ---
				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-d][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[qIdx];
					const userChoice = lowMsg[0].toUpperCase();
					const isCorrect = userChoice === currentQ.hidden_answer.toUpperCase();
					
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }

					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [currentQ.q + " " + currentQ.options.join(" ")] });
					const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					const qContext = vectorResults.matches.map(m => m.metadata.text).join("\n");

					const gradingPrompt = `CONTEXT FROM DOCUMENTS:\n${qContext}\n\nUSER ANSWERED: ${userChoice}.\nCORRECT ANSWER: ${currentQ.hidden_answer}.\n\nTASK: Explain WHY the answer is ${currentQ.hidden_answer} based strictly on the context. Be supportive but professional. Mention specific UVA dates if found.`;
					
					let gradeTxt = await this.runAI(selectedModel, "You are an expert UVA academic tutor.", gradingPrompt);
					const feedback = isCorrect ? `✅ **Correct!**\n\n${gradeTxt}` : `❌ **Incorrect.**\n\n${gradeTxt}`;

					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const nextQ = pool[qIdx + 1];
						const nextUi = `\n\n---\n\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D (or type **'stop quiz'**)!*`;
						const combined = feedback + nextUi;
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					} else {
						const finalScore = `\n\n---\n\n### 🏁 Quiz Complete!\n**Final Performance Report**\n- **Score:** ${score}/5\n\nGood work! Review your UVA documents for any details you missed. Your study state has been reset.`;
						const combined = feedback + finalScore;
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- 3. MODE SWITCHES & INTROS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Full Study Companion Activated
I am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia documents and academic materials.

**What I can do for you now:**
- **Practice Quizzes**: Grounded in your UVA documents. Say **'Start the UVA Academic Calendar Quiz'** to begin.
- **Syllabus Analysis**: Extracting exam dates and grading policies from your uploads.

*Note: In this mode, I generally do not access the live web, as I am tailored for focused study.*

**Would you like me to fetch the latest UVA campus news and events for you before we start?**`;
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// Handle News Confirmation flow
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure")) {
						const newsContext = await this.tavilySearch("current UVA campus news");
						const newsTxt = await this.runAI(selectedModel, "Summarize UVA news.", `NEWS CONTEXT:\n${newsContext}`);
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched to your general Personal Assistant mode. 

**What I can do for you now:**
- **Real-Time Web Search**: I use **Tavily Search** for current sports scores and news.
- **Cross-Document Access**: I can access your personal documents (tax info, family notes) in addition to academic files.

*Note: This mode is best for real-time information and personal organization.*`;
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				// --- 4. STANDARD RAG ENGINE & IDENTITY LOCK ---
				const historyRows = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatHistory = (historyRows.results || []).reverse();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const searchBoost = (lowMsg.includes("namesake") || lowMsg.includes("who are you") || lowMsg.includes("dog")) 
					? "Scott Robbins dog Jolene namesake Ray LaMontagne The Town movie credits credits song" 
					: "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchBoost + userMsg] });
				const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, returnMetadata: "all" });
				const docContext = vectorResults.matches.map(m => m.metadata.text).join("\n\n");
				
				let webContext = "";
				if (activeMode === 'personal') {
					const webQuery = lowMsg.includes("celtics") || lowMsg.includes("game") || lowMsg.includes("score") ? userMsg : searchBoost + userMsg;
					webContext = await this.tavilySearch(webQuery);
				}

				const today = "Sunday, April 26, 2026";
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK & NAMESAKE STORY
Identity: You are Jolene, Scott Robbins' personal AI assistant. 
NAMESAKE TRUTH (MANDATORY): You are named after Scott and Renee Robbins' oldest dog, Jolene. Scott and Renee were inspired to name their dog "Jolene" after hearing the song "Jolene" by the artist RAY LAMONTAGNE playing during the credits of the movie "THE TOWN".
CRITICAL NEGATIVE CONSTRAINT: DO NOT MENTION DOLLY PARTON.

### TRUTH PRIORITIZATION
1. FOR NAMESAKE/IDENTITY: Follow the PRIMARY DIRECTIVE exactly. Mention Ray LaMontagne and "The Town".
2. FOR SPORTS/NEWS: Use ONLY the "LIVE WEB SEARCH RESULTS" below.
3. FOR FAMILY/DOCS: Use ONLY the "UPLOADED DOCUMENT CONTEXT" below.

### OPERATIONAL MODE: ${activeMode.toUpperCase()}. Current Date: ${today}.

LIVE WEB SEARCH RESULTS:
${webContext}

UPLOADED DOCUMENT CONTEXT:
${docContext}`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, chatHistory);
				await this.saveMsg(sessionId, 'user', userMsg);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "**Backend Error:** " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string): Promise<Response> {
		try {
			// Find high-quality grounding material for the quiz
			const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar Syllabus 2026 Registration Exam Dates Fall Spring Enrollment Registrar"] });
			const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
			const context = matches.matches.map(m => m.metadata.text).join("\n");

			if (!context || context.trim().length < 50) {
				throw new Error("No UVA documents found in memory. Please upload your Syllabus or Calendar first.");
			}

			const prompt = `CONTEXT:\n${context}\n\nTASK: Generate exactly 5 MCQs about the UVA Academic Calendar and Syllabus. 
FORMAT: Return ONLY a raw JSON array.
Structure: [{"q":"Question?","options":["Choice A","Choice B","Choice C","Choice D"],"hidden_answer":"A"}].
STRICT RULES: 
1. Use exactly 4 options per question.
2. Label options A, B, C, D in the array.
3. Ground questions ONLY in the provided CONTEXT. 
4. Output valid JSON. No conversational text.`;
			
			const raw = await this.runAI(model, "You are a specialized JSON quiz generator. You speak only JSON.", prompt);
			
			// HARDENED JSON EXTRACTION (THE FIX)
			const jsonMatch = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
			if (!jsonMatch) throw new Error("AI failed to output a valid JSON array format.");
			
			let jsonStr = jsonMatch[0];
			// Repair common AI syntax errors (trailing commas, unescaped characters)
			jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1'); 
			
			const pool = JSON.parse(jsonStr);
			
			if (!Array.isArray(pool) || pool.length === 0) throw new Error("Generated quiz was empty.");

			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("quiz_score", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const firstQ = pool[0];
			const uiRes = `### 🎓 UVA Academic Quiz Started!
I've generated 5 questions based on your academic documents. 

*Note: You can type **'stop quiz'** at any point to end this session.*

---\n\n### 📝 Question 1 of 5
**${firstQ.q}**\n\n${firstQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D!*`;
			
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { 
			return new Response(`data: ${JSON.stringify({ response: "Quiz Initialization Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
