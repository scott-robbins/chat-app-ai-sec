import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// --- GROUND TRUTHS ---
const CALENDAR_TRUTH = `UVA 2026-2027 ACADEMIC CALENDAR: Fall starts Aug 25, 2026. Reading Days Oct 3-6. Thanksgiving Nov 25-29. Fall ends Dec 8. Spring starts Jan 20, 2027. Recess March 6-14. Spring ends May 4. Finals Weekend May 21-23.`;
const SYLLABUS_TRUTH = `CS 4750 SYLLABUS: Advisor Dr. Thomas Jefferson (Thornton Hall 1743). Mid-term topics: Cloudflare Vectorize, Durable Objects (D1), and KV Store. Exam: March 24, 2026. Tradition: Victory Bagel at Bodo’s. Success ID: WAHOO-AI-DEEP-RECALL.`;
const PERSONAL_GROUND_TRUTH = `Identity: Scott Robbins, Cloudflare Senior Solutions Engineer. Location: Plymouth, MA. Dogs: Jolene (Oldest) and Hanna. Namesake: Scott and Renee named their dog Jolene after the Ray LaMontagne song they heard during 'THE TOWN' movie credits. Jolene the AI is named after the dog. NEVER mention Dolly Parton.`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try { await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").bind(sessionId, role, content).run(); } catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = history.filter(m => m.role === 'user' || m.role === 'assistant').slice(-6);
		chatMessages.push({ role: "user", content: userQuery });
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		let url = model.startsWith("@cf/") ? `${gatewayBase}/workers-ai/${model}` : `${gatewayBase}/openai/chat/completions`;
		let headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${model.startsWith("@cf/") ? this.env.CF_API_TOKEN : this.env.OPENAI_API_KEY}` };
		let body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		return model.startsWith("@cf/") ? data.result.response : data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${query} May 2026 Plymouth MA`, search_depth: "advanced" }) });
			const data: any = await res.json();
			return data.results?.map((r: any) => `${r.title}: ${r.content}`).join("\n\n");
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const viewPref = await this.env.SETTINGS.get(`view_preference`) || "Fancy Mode";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: `Scott Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0, // FIXED: Triggers D1 Counter UI
				knowledgeAssets: storage.objects?.map(o => o.key) || [], // FIXED: Populates R2 Card
				mode: activeMode,
				activeQuiz: !!activePool
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				if (lowMsg.includes("fancy mode")) { await this.env.SETTINGS.put(`view_preference`, "Fancy Mode"); return new Response(`data: ${JSON.stringify({ response: "Updated to **Fancy Mode**!" })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("plain mode")) { await this.env.SETTINGS.put(`view_preference`, "Plain Mode"); return new Response(`data: ${JSON.stringify({ response: "Switched to **Plain Mode**." })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("stop quiz")) { await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state"); return new Response(`data: ${JSON.stringify({ response: "### 🛑 Quiz Stopped" })}\n\ndata: [DONE]\n\n`); }

				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					let score = await this.ctx.storage.get("quiz_score") as number || 0;
					const currentQ = pool[qIdx];
					const isCorrect = lowMsg.startsWith(currentQ.hidden_answer.toLowerCase());
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** Answer: ${currentQ.hidden_answer}`;
					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const next = pool[qIdx + 1];
						const combined = `${feedback}\n\n### Question ${qIdx + 2}\n**${next.q}**\n\n${next.options.join('\n')}`;
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					} else {
						await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state");
						const final = `${feedback}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**`;
						await this.saveMsg(sessionId, 'assistant', final);
						return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("quiz")) return this.initQuizPool(sessionId, body.model || DEFAULT_CF_MODEL);

				if (lowMsg.includes("uva mode")) { await this.env.SETTINGS.put(`active_mode`, "uva"); const res = `### 🎓 UVA Mode Activated\nReady for academic materials.`; await this.saveMsg(sessionId, 'assistant', res); return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("personal mode")) { await this.env.SETTINGS.put(`active_mode`, "personal"); const res = `### 🏠 Personal Mode Activated\nReady for search and document access.`; await this.saveMsg(sessionId, 'assistant', res); return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`); }

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let liveContext = "";
				if (lowMsg.includes("stock") || lowMsg.includes("weather") || lowMsg.includes("news")) liveContext = await this.tavilySearch(userMsg);

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				// FIX: Broaden search to find the Cloudflare note regardless of mode segment
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `You are Jolene, Scott's dedicated assistant. Warm and professional.
1. IDENTITY: Scott's dogs are Jolene and Hanna. Jolene was named after the Ray LaMontagne song in 'THE TOWN' credits. NEVER mention Dolly Parton.
2. MEMORY: When Scott asks you to recall a note, repeat ONLY what is in RETRIEVED_CONTEXT. Do NOT hallucinate extra items.
3. CONTEXT: ${PERSONAL_GROUND_TRUTH} | ${activeMode === 'uva' ? SYLLABUS_TRUTH + CALENDAR_TRUTH : ''}
RETRIEVED_CONTEXT: ${docContext.substring(0, 4000)}
${liveContext ? `LIVE WEB: ${liveContext}` : ''}`;

				const chatTxt = await this.runAI(body.model || DEFAULT_CF_MODEL, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs. JSON ONLY: [{"q":"?","options":["A.","B.","C.","D."],"hidden_answer":"A"}]`;
		const raw = await this.runAI(model, "JSON ONLY.", prompt);
		const jsonStr = raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1);
		const pool = JSON.parse(jsonStr);
		await this.ctx.storage.put("quiz_pool", pool); await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0); await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const res = `### 🎓 UVA Quiz Started\n\n**${pool[0].q}**\n\n${pool[0].options.join('\n')}`;
		await this.saveMsg(sessionId, 'assistant', res);
		return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
