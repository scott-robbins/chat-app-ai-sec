import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// FIXED: Verified correct model name for RAG operations
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
		
		// Ensure strictly alternating User -> Assistant roles for Claude/Anthropic compatibility
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) {
					chatMessages.push(msg);
				}
			}
		}

		// Ensure the stack ends with the current 'user' message
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// 1. NATIVE WORKERS AI
		if (model.startsWith("@cf/")) {
			const run: any = await this.env.AI.run(model as any, { 
				messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
			});
			return run.response || run;
		}

		// 2. EXTERNAL PROVIDERS VIA AI GATEWAY
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

		if (model.includes("gpt")) {
			const res = await fetch(`${gatewayBase}/openai/chat/completions`, {
				method: "POST",
				headers: { "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ 
					model, 
					messages: [{ role: "system", content: systemPrompt }, ...chatMessages] 
				})
			});
			const data: any = await res.json();
			if (data.error) throw new Error(data.error.message);
			return data.choices[0].message.content;
		}

		if (model.includes("claude")) {
			const res = await fetch(`${gatewayBase}/anthropic/messages`, {
				method: "POST",
				headers: {
					"x-api-key": this.env.ANTHROPIC_API_KEY,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					max_tokens: 1024,
					system: systemPrompt,
					messages: chatMessages
				})
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`Claude Error: ${data.error.message || JSON.stringify(data.error)}`);
			return data.content[0].text;
		}

		throw new Error(`Model ${model} not supported.`);
	}

	async tavilySearch(query: string) {
		try {
			const response = await fetch('https://api.tavily.com/search', {
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

		// --- COMMAND CENTER SYNC ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				
				// Restore Active Learning Session Detection for Dashboard
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

				// --- 1. QUIZ STATE MACHINE (PRIORITY HANDLER) ---
				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				// Handle Answer Input
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-d][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[qIdx];
					const userChoice = lowMsg[0].toUpperCase();
					const isCorrect = userChoice === currentQ.hidden_answer.toUpperCase();
					
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }

					// Fetch context for the grading explanation
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [currentQ.q + " " + currentQ.options.join(" ")] });
					const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					const qContext = vectorResults.matches.map(m => m.metadata.text).join("\n");

					const gradingPrompt = `USER ANSWERED: ${userChoice}. CORRECT WAS: ${currentQ.hidden_answer}. 
EXPLAIN WHY using this context: ${qContext}. Be supportive but precise. Ground your explanation in the UVA documents.`;
					
					let gradeTxt = await this.runAI(selectedModel, "You are a professional UVA academic tutor.", gradingPrompt);
					const feedback = isCorrect ? `✅ **Correct!**\n\n${gradeTxt}` : `❌ **Incorrect.**\n\n${gradeTxt}`;

					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const nextQ = pool[qIdx + 1];
						const nextUi = `\n\n---\n\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D!*`;
						const combined = feedback + nextUi;
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					} else {
						const finalScore = `\n\n---\n\n### 🏁 Quiz Complete!\n**Final Performance Report**\n- **Score:** ${score}/5\n\nGood effort! Review your UVA docs for any missed details.`;
						const combined = feedback + finalScore;
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- 2. MODE SWITCHES ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Full Study Companion Activated
I am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia documents and academic materials.

**What I can do for you now:**
- **Practice Quizzes**: Grounded in your UVA documents. Say **'Start a Quiz'** to begin.
- **Syllabus Analysis**: Extracting exam dates and grading policies from your uploads.

*Note: In this mode, I generally do not access the live web, as I am tailored for focused study.*

**Would you like me to fetch the latest UVA campus news and events for you before we start?**`;
					await this.saveMsg(sessionId, 'user', userMsg);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// Handle News Confirm state
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
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				// --- 3. STANDARD RETRIEVAL & CHAT ---
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

				// --- 4. HARDENED IDENTITY LOCK PROMPT ---
				const today = "Sunday, April 26, 2026";
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK & NAMESAKE STORY
Identity: You are Jolene, Scott Robbins' personal AI assistant. 
NAMESAKE TRUTH (MANDATORY): You are named after Scott and Renee Robbins' oldest dog, Jolene (a tan mini dachshund). Scott and Renee were inspired to name their dog "Jolene" after hearing the song "Jolene" by the artist RAY LAMONTAGNE playing during the credits of the movie "THE TOWN". You are named after that dog.
CRITICAL NEGATIVE CONSTRAINT: DO NOT MENTION DOLLY PARTON. You are NOT named after the Dolly Parton song.

### FAMILY CONTEXT
Scott and Renee are your people. Their daughter is Bryana. Grandkids are Callan and Josie. Your youngest "sister" is Hanna (a black and tan mini dachshund).
TAXES: The tax base fee is $375 for the first hour and $275 per hour thereafter (per the 2025 engagement letter).

### TRUTH PRIORITIZATION
1. FOR NAMESAKE/IDENTITY: Follow the PRIMARY DIRECTIVE above exactly. Mention Ray LaMontagne and "The Town".
2. FOR SPORTS/NEWS: Use ONLY the "LIVE WEB SEARCH RESULTS" below. Do NOT use your training data for dates or scores.
3. FOR FAMILY/TAXES: Use ONLY the "UPLOADED DOCUMENT CONTEXT" below.

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
			const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar Syllabus Exam Dates Enrollment Registration"] });
			const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
			const context = matches.matches.map(m => m.metadata.text).join("\n");

			const prompt = `CONTEXT:\n${context}\n\nTASK: Generate exactly 5 MCQs about the UVA Academic Calendar and Syllabus. 
STRICT FORMAT: Return ONLY a raw JSON array. No conversational text.
Structure: [{"q":"Question?","options":["Choice A","Choice B","Choice C","Choice D"],"hidden_answer":"A"}].
RULES: 
1. Use exactly 4 options labeled A, B, C, D.
2. Ground questions strictly in the provided CONTEXT. 
3. Ensure the JSON is valid and parsable.`;
			
			const raw = await this.runAI(model, "You are a specialized academic quiz generator.", prompt);
			
			// Hardened Extraction & Repair
			const jsonStart = raw.indexOf('[');
			const jsonEnd = raw.lastIndexOf(']') + 1;
			if (jsonStart === -1 || jsonEnd === -1) throw new Error("AI failed to output a valid JSON array.");
			let jsonStr = raw.substring(jsonStart, jsonEnd);
			
			// Fix trailing commas and common AI mistakes
			jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1');
			
			const pool = JSON.parse(jsonStr);
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("quiz_score", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const firstQ = pool[0];
			const uiRes = `### 🎓 UVA Academic Quiz Started!\nI've generated 5 questions based on your documents. Good luck!\n\n---\n\n### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, C, or D!*`;
			
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
