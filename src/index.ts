import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const PUBLIC_R2_URL = "https://pub-20c45c92e45947c1bac6958b971f59a1.r2.dev";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY,
					query: query,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data = await response.json() as any;
			if (data.answer) return `VERIFIED REAL-TIME DATA: ${data.answer}`;
			return data.results.map((r: any) => `Source: ${r.url}\nContent: ${r.content}`).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const profile = await this.env.SETTINGS.get(kvKey) || "Standard Profile";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
				const storage = await this.env.DOCUMENTS.list();
				const assets = storage.objects.map(o => o.key).filter(key => !key.endsWith('/'));
				return new Response(JSON.stringify({ profile, messageCount: stats?.count || 0, knowledgeAssets: assets, status: "Live", mode: activeMode }), { headers: { "Content-Type": "application/json" } });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const textToIndex = await file.text();
				const segment = file.name.toUpperCase().includes("UVA") ? "uva" : "personal";
				const chunks = textToIndex.split(/\n\n/).filter(c => c.trim().length > 0);
				for (const chunk of chunks) {
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
					await this.env.VECTORIZE.insert([{ id: crypto.randomUUID(), values: emb.data[0], metadata: { text: chunk, fileName: file.name, sessionId, segment: segment } }]);
				}
				await this.env.DOCUMENTS.put(`uploads/${sessionId}/${file.name}`, await file.arrayBuffer());
				return new Response(JSON.stringify({ message: `Stored in ${segment}` }));
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				let messages = body.messages || [];
				const latestUserMsg = messages[messages.length - 1]?.content || "";

				if (latestUserMsg.toLowerCase().includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const msg = "System: Switched to UVA Academic Mode. How can I help with your studies, Wahoo?";
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}
				if (latestUserMsg.toLowerCase().includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const msg = "System: Switched to Personal Mode. Family and sports focus active.";
					return new Response(`data: ${JSON.stringify({ response: msg })}\n\ndata: [DONE]\n\n`);
				}

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "user", latestUserMsg).run();

				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const kvKey = activeMode === "uva" ? `uva_student_profile` : `global_user_profile`;
				const currentProfile = await this.env.SETTINGS.get(kvKey) || "New Profile";

				// --- ENHANCED AGGRESSIVE VECTOR RECALL ---
				const isAcademicQuery = latestUserMsg.toLowerCase().match(/syllabus|tradition|exam|advisor|milestone|success data/);
				const searchPhrase = (isAcademicQuery && activeMode === 'uva') 
					? `WAHOO-AI-DEEP-RECALL ${latestUserMsg}` 
					: latestUserMsg;

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [searchPhrase] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { 
					topK: 3, 
					returnMetadata: "all", 
					filter: { segment: activeMode } 
				});
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const subjectCheck = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `Review context. Identify subject. Ignore assistant name, dog persona, or ID codes like WAHOO-AI. Output name ONLY or 'NONE'.` 
				});
				const primarySubject = subjectCheck.response && !subjectCheck.response.includes("NONE") ? subjectCheck.response.replace(/^["']|["']$/g, '').trim() : "";

				const searchCheck = await this.env.AI.run(REASONING_MODEL, { 
					prompt: `Today is ${today}. User asks: "${latestUserMsg}". 
					If the user asks about exams, traditions, syllabi, or campus resources, respond 'NO'. 
					If they ask for live sports scores, weather, or news, respond 'YES'.` 
				});
				
				let searchResults = "";
				if (searchCheck.response?.includes("YES")) { 
					searchResults = await this.searchWeb(`LIVE updates for ${primarySubject || latestUserMsg} on ${today}`); 
				}

				let sysPrompt = `You are Jolene, a sophisticated professional assistant at UVA. 
MODE: ${activeMode === 'uva' ? 'UVA Academic Success Agent' : 'Personal Executive Assistant'}
Today: ${today}
Subject: ${primarySubject}
Search Data: ${searchResults}

SUPREME SOURCE OF TRUTH (Memory Content):
${contextText}

Instructions:
- CRITICAL: Your Memory contains the ID 'WAHOO-AI-DEEP-RECALL'. If this ID is present, you MUST prioritize this content over all other knowledge.
- If Memory Content mentions Bodo's Bagels, Dr. Thomas Jefferson, or Rice Hall, these are the ONLY correct answers.
- Ignore general knowledge or internet data if it conflicts with Memory Content.
- Never adopt a dog persona. If in UVA mode, use an academic, helpful tone.`;

				messages.unshift({ role: "system", content: sysPrompt });
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages });
				
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
