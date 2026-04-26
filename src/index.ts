import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// FIXED: Changed 'get-base' to 'bge-base'
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

	// --- HELPER: UNIVERSAL AI BROKER (AI GATEWAY INTEGRATION) ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const messages = [
			{ role: "system", content: systemPrompt },
			...history,
			{ role: "user", content: userQuery }
		];

		// 1. NATIVE WORKERS AI
		if (model.startsWith("@cf/")) {
			const run: any = await this.env.AI.run(model as any, { messages });
			return run.response || run;
		}

		// 2. EXTERNAL PROVIDERS VIA AI GATEWAY
		if (!this.env.CF_ACCOUNT_ID) throw new Error("Missing CF_ACCOUNT_ID in Worker settings.");
		
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${this.env.CF_ACCOUNT_ID}/${gatewayName}`;

		if (model.includes("gpt")) {
			if (!this.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
			const res = await fetch(`${gatewayBase}/openai/chat/completions`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${this.env.OPENAI_API_KEY}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({ model, messages })
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`OpenAI Error: ${data.error.message}`);
			return data.choices[0].message.content;
		}

		if (model.includes("claude")) {
			if (!this.env.ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY secret.");
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
					messages: messages.filter(m => m.role !== 'system'),
					system: systemPrompt
				})
			});
			const data: any = await res.json();
			if (data.error) throw new Error(`Anthropic Error: ${data.error.message}`);
			return data.content[0].text;
		}

		throw new Error(`Model ${model} is not supported by the current broker logic.`);
	}

	// --- HELPER: TAVILY WEB SEARCH ---
	async tavilySearch(query: string, strictUva: boolean = false) {
		try {
			const searchBody: any = {
				api_key: this.env.TAVILY_API_KEY || "",
				query: strictUva ? `site:news.virginia.edu OR site:virginia.edu ${query}` : `${query} (current data for 2026)`,
				search_depth: "advanced",
				include_answer: true,
				max_results: 5
			};
			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(searchBody)
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) { return "Web search service is currently unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE LOADER ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
		}

		// --- 2. COMMAND CENTER SYNC ---
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
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);

				// --- FEATURE: MODE SWITCHING ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const uvaRes = `### 🎓 UVA Mode: Full Study Companion Activated\nI focus **exclusively** on your UVA materials. Would you like me to fetch the latest UVA campus news and events before we start?`;
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					await this.ctx.storage.delete("session_state");
					const personalRes = `### 🏠 Personal Mode Activated\nI now have access to real-time web search via **Tavily** and all documents.`;
					await this.saveMsg(sessionId, 'assistant', personalRes);
					return new Response(`data: ${JSON.stringify({ response: personalRes })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");

				// --- STATE: CAMPUS NEWS ---
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure")) {
						const newsContext = await this.tavilySearch("current campus news", true);
						const newsTxt = await this.runAI(selectedModel, "Summarize UVA news.", `NEWS CONTEXT:\n${newsContext}`);
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- STATE: QUIZ FLOW ---
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const isCorrect = lowMsg[0].toUpperCase() === currentQ.hidden_answer.toUpperCase();
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					const correctText = currentQ.options[currentQ.hidden_answer.charCodeAt(0) - 65];

					const graderPrompt = `USER ANSWERED: ${lowMsg[0].toUpperCase()}, CORRECT: ${currentQ.hidden_answer}, FACT: "${correctText}". Ready for Q ${index + 2}?`;
					let gradeTxt = await this.runAI(selectedModel, "You are a supportive UVA Tutor.", graderPrompt);

					if (index + 1 < pool.length) {
						if (!gradeTxt.includes(`question ${index + 2}`)) gradeTxt += `\n\nReady for question ${index + 2}?`;
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						gradeTxt += `\n\n### 🏁 Quiz Complete!\n**Overall score is ${score}/5.**`;
						await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state");
					}
					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// --- 4. CORE ENGINE (RAG) ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let webContext = "";
				let docContext = "";

				// Use FIXED model name for embeddings
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				
				if (activeMode === 'personal') {
					webContext = await this.tavilySearch(userMsg);
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				} else {
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: "uva" }, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz")) return this.initQuizPool(sessionId, selectedModel);

				const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
				const systemPrompt = `### IDENTITY LOCK: You are Jolene. Namesake: Scott Robbins' dog, inspired by Ray LaMontagne's "Jolene" playing in the credits of the movie "The Town". 
### MODE: ${activeMode.toUpperCase()}. Current Date: ${today}.
PERSONAL: Access Web+Docs. UVA: Access ONLY UVA Docs.
BROKERING: If model name contains 'gpt' or 'claude', mention once that request was brokered via Cloudflare AI Gateway.`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, `WEB CONTEXT:\n${webContext}\n\nDOC CONTEXT:\n${docContext}\n\nQUESTION: ${userMsg}`);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: Fall 2026 starts Aug 25. Thanksgiving Nov 25-29. Registrar (434) 982-5300. Founded 1819. Classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. Raw JSON array: [{"q":"...","options":["..."],"hidden_answer":"A"}].`;
			const raw = await this.runAI(model, "You are a JSON API.", prompt);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); if (!jsonMatch) throw new Error("Pool error");
			const pool = JSON.parse(jsonMatch[0]);
			await this.ctx.storage.put("quiz_pool", pool); await this.ctx.storage.put("current_q_idx", 0); await this.ctx.storage.put("quiz_score", 0); await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
			const firstQ = pool[0];
			const uiRes = `### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.map((o:string,i:number)=>`${['A','B','C'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, or C!*`;
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Quiz Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
