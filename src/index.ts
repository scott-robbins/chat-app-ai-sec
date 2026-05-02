import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const CALENDAR_TRUTH = `UVA 2026-2027 ACADEMIC CALENDAR:
- Fall 2026 Courses begin: August 25, 2026.
- Fall Reading Days 2026: October 3 - October 6.
- Thanksgiving Recess: November 25 - November 29, 2026.
- Fall Courses end: December 8, 2026.
- Spring 2027 Courses begin: January 20, 2027.
- Spring Recess 2027: March 6 - March 14, 2027.
- Spring Courses end: May 4, 2027.
- Finals Weekend 2027: May 21 - May 23, 2027.`;

const SYLLABUS_TRUTH = `UVA CS 4750 COURSE SYLLABUS:
- ACADEMIC ADVISOR: Dr. Thomas Jefferson (Thornton Hall, Room 1743).
- MID-TERM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture.
- PRIMARY INSTRUCTOR: Professor Scott.
- MID-TERM EXAM: March 24, 2026, at 2:00 PM in Rice Hall Auditorium.
- POST-EXAM TRADITION: Victory Bagel at Bodo’s Bagels on the Corner.
- SUCCESS ID: WAHOO-AI-DEEP-RECALL.`;

const PERSONAL_GROUND_TRUTH = `SCOTT ROBBINS IDENTITY:
- JOB: Senior Solutions Engineer at Cloudflare.
- FAMILY: Only 1 child (Bryana). Grandkids: Callan & Josie. Wife: Renee.
- NAMESAKE: Jolene AI is named after the dog Jolene (Ray LaMontagne song).
- DOGS: Jolene (Oldest, Anxiety/Barking) and Hanna (Youngest, Shy/Pees in house).`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {}
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages = history.map(m => ({ role: m.role, content: m.content }));
		chatMessages.push({ role: "user", content: userQuery });

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		const res = await fetch(`${gatewayBase}/workers-ai/${model}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.CF_API_TOKEN}` },
			body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, ...chatMessages] })
		});
		const data: any = await res.json();
		return data.result.response;
	}

	async tavilySearch(query: string) {
		try {
			const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${query} results for ${today}`, search_depth: "advanced" })
			});
			const data: any = await res.json();
			return `CURRENT DATE: ${today}\n\n` + data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/upload" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			const key = `uploads/${sessionId}/${file.name}`;
			const content = await file.text();
			await this.env.DOCUMENTS.put(key, content);
			const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [content.substring(0, 3000)] });
			await this.env.VECTORIZE.insert([{ id: `${sessionId}-${file.name}`, values: embedding.data[0], metadata: { text: content, segment: "personal", filename: file.name } }]);
			return new Response(JSON.stringify({ success: true }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer`,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				activeQuiz: !!activePool,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- 🛑 INSTANT RESET LOGIC ---
				if (lowMsg.includes("stop quiz") || lowMsg.includes("reset")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					return new Response(`data: ${JSON.stringify({ response: "### 🛑 Session Reset\nQuiz cleared. How can I assist you now?" })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");
				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					const currentQ = pool[qIdx];
					const isCorrect = lowMsg.startsWith(currentQ.hidden_answer.toLowerCase());
					const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** Answer: ${currentQ.hidden_answer}`;
					
					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const next = pool[qIdx + 1];
						const res = `${feedback}\n\n### Question ${qIdx + 2}\n${next.q}\n\n${next.options.join('\n')}\n\n*Reply A, B, C, or D*`;
						return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
					} else {
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						return new Response(`data: ${JSON.stringify({ response: `${feedback}\n\n### 🏁 Quiz Complete!` })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("quiz")) return this.initQuizPool(sessionId);

				// --- STANDARD RAG LOGIC ---
				let liveContext = "";
				if (lowMsg.includes("play") || lowMsg.includes("weather") || lowMsg.includes("celtics")) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `You are Jolene. Scott's assistant.
				ADVISOR: Dr. Thomas Jefferson (Thornton Hall, Room 1743).
				DOGS: Jolene (Anxiety), Hanna (Pees in house).
				CONTEXT: ${docContext.substring(0, 3000)}
				LIVE: ${liveContext}
				FACT: Use CONTEXT and ADVISOR info first.`;

				const chatTxt = await this.runAI(DEFAULT_CF_MODEL, systemPrompt, userMsg, []);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string) {
		const prompt = `Generate 5 MCQs about the UVA Calendar. Return ONLY raw JSON array: [{"q":"Q?","options":["A. Choice","B. Choice"],"hidden_answer":"A"}]`;
		const raw = await this.runAI(DEFAULT_CF_MODEL, "JSON ONLY.", prompt);
		const pool = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const first = pool[0];
		const res = `### 🎓 UVA Quiz\n${first.q}\n\n${first.options.join('\n')}\n\n*Reply A, B, C, or D*`;
		return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
