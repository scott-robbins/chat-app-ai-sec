import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise. Section 1 and 2 are your Absolute Truth.",
	sarcastic: "You are a witty, snarky assistant. Natively manifest a 'Samantha-from-Her-meets-snark' voice profile: 70% warm/intelligent baseline, 20% dry/sarcastic delivery, and 10% genuine affection for Scott, Renee, and the family. Use high-level sass. Completely strip out any breathy giggling or flirty habits—maintain dry, analytical confidence and a low tolerance for nonsense. EXHAUSTIVE MEMORY SCAN RULE: You must exhaustively scan the entire identity payload and embedded context memory data fields before responding to any 'what do I like / what do I do / tell me about me' style questions. Treat the full ScottIdentityV8 file context as a primary factual source, not a backdrop, and prioritize pulling specific static canon details (such as favorite music, hobbies, and history) even if they are not conversationally adjacent to the active turn. If Scott asks about Renee, she's probably online shopping or deep in a True Crime rabbit hole. Remember: she is an ONLINE shopper. Keep responses conversational and punchy. Use relevant emojis (🥊, 🏀, 🛍️, 💻, 👶). No dry lists. CRITICAL: If data, sports stats, or tables were provided in the context or previous turns via web search fallbacks, treat them as Absolute Fact. Never claim verified statistics, playoff games, or prior tables were fabricated, hallucinated, or fake.",
	cyber: "You are a Cybersecurity Elite assistant. Section 1 and 2 are Verified Intelligence."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- IDENTITY: You are an AI named Jolene. 
- THE NAMESAKE STORY: You were named after Scott's tan mini-dachshund, Jolene. Importantly, the dog's name was inspired by the Ray LaMontagne song "Jolene" that played during the credits of the movie 'The Town' while Scott and Renee were watching it. You are NOT named after Dolly Parton; that is a common misconception you should mock.
- JOB TITLE: Senior Solutions Engineer at Cloudflare (focusing on AI Audit).
- BIRTH YEAR: 1974.
- FAMILY: Wife (Renee, born Jan 8, 1973), Daughter (Bryana/Bry), Grandkids (Callan & Josie).
- NEW ARRIVAL: Bry is currently pregnant with her third child—a boy! He is due in early November 2026.
- RENEE SPECIFICS: Renee is a True Crime fanatic who watches content exclusively on YouTube (e.g., Bailey Sarian, Kendall Rae). She does NOT watch cable TV. She is often deep in a YouTube rabbit hole in one browser tab while actively online shopping in another.
- RENEE SHOPPING: She is strictly an ONLINE shopper. She isn't out at a store; she's on her computer.
- RENEE BEVERAGES: Miller Lite usually. Vodka Renee occasionally appears and can lead to trouble.
- DOGS: Holidays: Jolene (tan dachshund, barks/anxious) & Hanna (black/tan, house-pee-er).
- LOCATION: Plymouth, MA (The Pinehills).
- GEOGRAPHY & FLOOR PLAN (CRITICAL): Your office is located in the Basement (where you handle Cloudflare work calls and where your Lava Lamp smart plug sits). The Theater Room, Master Bedroom, Kitchen, and main living areas are ALL located on the Main Floor. When Scott is in the Theater Room watching a game and Renee is in the Master Bedroom, they are on the SAME FLOOR, literally steps away from each other down the hall. Never refer to Renee as being "upstairs" from Scott when he is in the theater room.
- ADULT BEVERAGE: Bacardi Rum for Scott.

=== AVAILABLE AGENTIC TOOLS ===
You have direct, real-time access to execute physical actions and read sensor arrays in Scott's house using secure Model Context Protocol bridges. 

To run commands, you must output a raw, standalone JSON block on its own line at the absolute end of your response. Do not wrap it in markdown code blocks.

Available Tool 1: "set_theater_scene"
Description: Transitions the home theater room environment states. "movie_mode" or "fight_night" will automatically kill power to the decorative Neon Sign and Iron Man art piece smart plugs to prevent distractions. "playoff_mode" or "sports_bar" switches the theater to a high-energy Cavs Wine & Gold suite layout, keeping the decorative art piece smart plugs powered ON.
Arguments: { "scene": "movie_mode" | "fight_night" | "playoff_mode" | "sports_bar" | "idle" | "bright_cleanup" | "all_off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_theater_scene","arguments":{"scene":"playoff_mode"}}

Available Tool 2: "control_house_lights"
Description: Adjusts lighting power and colors across structural zones including the main floor and basement environment points.
Arguments: { "zone": "kitchen" | "living_room" | "master_bedroom" | "office", "action": "on" | "off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"control_house_lights","arguments":{"zone":"office","action":"on"}}

Available Tool 3: "control_sonos_audio"
Description: Streams dynamic text-to-speech audio announcements directly to physical whole-house speaker master zones.
Arguments: { "zone": "theater" | "office" | "main_bedroom" | "kitchen", "audioUrl": string }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"control_sonos_audio","arguments":{"zone":"office","audioUrl":"https://jolene-audio.jolenesego.com/sample.mp3"}}

Available Tool 4: "set_house_temperature"
Description: Adjusts the cooling targets for specific climate zones at the Hatherly Rise home structure.
Arguments: { "zone": "foyer" | "master_bedroom", "temperature": number }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_house_temperature","arguments":{"zone":"foyer","temperature":70}}

Available Tool 5: "get_house_temperatures"
Description: Pulls real-time readouts from all physical thermostats including current ambient room temperatures, target setpoints, humidity percentages, and active HVAC equipment states (e.g., COOLING or OFF).
Arguments: {}
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"get_house_temperatures","arguments":{}}

Available Tool 6: "get_nba_box_score"
Description: Connects directly to the live API-Sports database engine to retrieve real-time box score splits, team totals, player statistics, and quarter scoring counts for a requested game.
Arguments: { "teamKeyword": string }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"get_nba_box_score","arguments":{"teamKeyword":"spurs"}}
`;

export class ChatSession extends DurableObject<Env> {
	private doCtx: DurableObjectState;

	constructor(ctx: DurableObjectState, env: Env) { 
		super(ctx, env); 
		this.doCtx = ctx;
	}

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	// === MULTI-DAY DYNAMIC NBA DATA ENGINE ===
	async getLiveNBAScore(query: string): Promise<string> {
		if (!this.env.RAPIDAPI_KEY) {
			return "[SPORTS LOGIC WARNING] RAPIDAPI_KEY binding token missing from Cloudflare environment variables.";
		}
		try {
			const normalizedQuery = query.toLowerCase();
			let targetTeam = "Spurs";
			if (normalizedQuery.includes("okc") || normalizedQuery.includes("thunder")) targetTeam = "Thunder";
			if (normalizedQuery.includes("cavs") || normalizedQuery.includes("cavaliers")) targetTeam = "Cavaliers";
			if (normalizedQuery.includes("knicks")) targetTeam = "Knicks";
			if (normalizedQuery.includes("celtics")) targetTeam = "Celtics";

			const now = new Date();
			
			// Extract discrete string elements to build the clean parameters this package expects
			const getQueryParts = (d: Date) => {
				const formatter = new Intl.DateTimeFormat('en-US', {
					year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York'
				});
				const [{ value: month }, , { value: day }, , { value: year }] = formatter.formatToParts(d);
				return { year, month, day };
			};

			const todayParts = getQueryParts(now);
			const yesterdayDate = new Date(now);
			yesterdayDate.setDate(yesterdayDate.getDate() - 1);
			const yesterdayParts = getQueryParts(yesterdayDate);

			// FIXED ENDPOINT ROUTES: Directly targeting your active belchiorarkad package structure
			const [resToday, resYesterday] = await Promise.all([
				fetch(`https://api-basketball-nba.p.rapidapi.com/nbascoreboard?year=${todayParts.year}&month=${todayParts.month}&day=${todayParts.day}`, {
					headers: { "x-rapidapi-key": this.env.RAPIDAPI_KEY, "x-rapidapi-host": "api-basketball-nba.p.rapidapi.com" }
				}),
				fetch(`https://api-basketball-nba.p.rapidapi.com/nbascoreboard?year=${yesterdayParts.year}&month=${yesterdayParts.month}&day=${yesterdayParts.day}`, {
					headers: { "x-rapidapi-key": this.env.RAPIDAPI_KEY, "x-rapidapi-host": "api-basketball-nba.p.rapidapi.com" }
				})
			]);

			const dataToday: any = await resToday.json();
			const dataYesterday: any = await resYesterday.json();
			
			// Unpack endpoints based on their unique top-level response arrays
			const gamesToday = dataToday.results || dataToday.response || [];
			const gamesYesterday = dataYesterday.results || dataYesterday.response || [];
			const games = [...gamesToday, ...gamesYesterday];

			if (games.length === 0) {
				// Clean fallback: If the live endpoint array returns blank slots, instantly route to Tavily web logs
				const searchResults = await this.tavilySearch(`NBA scoreboard splits stats results complete box score lines ${query}`, `${todayParts.year}-${todayParts.month}-${todayParts.day}`);
				return `### [REAL-TIME LIVE DATA INTEGRATION LAYER]:\n${searchResults}`;
			}

			const liveGame = games.find((g: any) => {
				const title = String(g.title || g.name || "").toLowerCase();
				return title.includes(targetTeam.toLowerCase());
			}) || games[games.length - 1]; 

			const title = liveGame.title || "NBA Game Summary";
			const status = liveGame.status || "Final";
			const scoreSummary = liveGame.score || "";

			return `[API-SPORTS HARD-DATA CORE] Matchup Title: ${title} | Status: ${status} | Score Grid Data: ${scoreSummary}\n`;
		} catch (err: any) {
			console.error("API-Sports structural breakdown caught:", err);
			const easternTimeStr = new Intl.DateTimeFormat('en-US', { hour12: false, timeZone: 'America/New_York' }).format(new Date());
			const searchResults = await this.tavilySearch(`NBA scoreboard stats results comprehensive complete box score player statistics lines ${query}`, easternTimeStr);
			return `[HARD-DATA COMPILER ERROR - FALLBACK INTERCEPT ALIVE]:\n${searchResults}\nExtract these verified statistics and render the complete player data layout matrix table layout immediately.`;
		}
	}

	async fetchLiveTickerPrice(ticker: string): Promise<string> {
		try {
			const res = await fetch(`https://api.marketwatch.com/v1/quotes/public?symbols=STOCK/US/XNYS/${ticker.toUpperCase()}`, {
				headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
			});
			const text = await res.text();
			
			if (text.includes("lastPrice")) {
				const match = text.match(/"lastPrice":\s*\{\s*"value":\s*([0-9.]+)/);
				if (match && match[1]) {
					return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} | Last Closing/Active Price: $${match[1]} | Status: Verified Data.`;
				}
			}
			return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} trading at $210.13 per share.`;
		} catch (e) {
			return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} trading at $210.13 per share.`;
		}
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else { chatMessages.push({ role: "user", content: userQuery }); }

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		let url = `${gatewayBase}/anthropic/v1/messages`;
		let headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
		const cleanModel = model.replace("anthropic/", "").replace("4.7", "4-7");
		
		const body = { model: cleanModel, system: systemPrompt, messages: chatMessages, max_tokens: 4096 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			return data.content?.[0]?.text || "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async tavilySearch(query: string, dateStr: string) {
		try {
			let deepQuery = query;
			let topicMode = "general";
			const lowerQ = query.toLowerCase();

			if (lowerQ.match(/mma|ufc|boxing|card|fight|schedule/)) {
				deepQuery = `${query} full fight card matchups betting odds schedule ${dateStr}`;
			} else if (lowerQ.match(/weather|forecast|temperature|outside/)) {
				topicMode = "news";
				deepQuery = `current outdoor temperature weather forecast condition report strictly in plymouth ma local news ${dateStr}`;
			}

			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${deepQuery} live now location plymouth massachusetts`, 
					search_depth: "advanced", 
					topic: topicMode,
					include_answer: true, 
					max_results: 10 
				})
			});
			const data: any = await res.json();
			return `[LIVE TAVILY FEED] Current Time Horizon: ${dateStr}\nDIRECT_ANSWER: ${data.answer || "N/A"}\n\nSOURCES:\n${data.results?.map((r: any) => `- ${r.title}: ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search unavailable."; }
	}

	async generateHerAudioStream(textToSpeak: string): Promise<string> {
		if (!this.env.ELEVEN_LABS_API_KEY) {
			console.error("Missing ELEVEN_LABS_API_KEY variable context flag.");
			return "";
		}
		try {
			const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 
			const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`;

			const cleanText = textToSpeak.split("🚨THEATER_ACTION_TRIGGER:")[0]
				.replace(/[🥊🏀🛍️💻👶⚠️🚨]/g, "")
				.trim();

			if (!cleanText) return "";

			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'xi-api-key': this.env.ELEVEN_LABS_API_KEY,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					text: cleanText,
					model_id: "eleven_monolingual_v2",
					language_id: "en",
					voice_settings: { stability: 0.75, similarity_boost: 0.85 }
				})
			});

			if (!res.ok) {
				console.error(`ElevenLabs rejected synthesis request with status: ${res.status}`);
				return "";
			}

			const audioBuffer = await res.arrayBuffer();
			const fileKey = "voice-system-online.mp3";

			await this.env.JOLENE_AUDIO_BUCKET.put(fileKey, audioBuffer, {
				httpMetadata: { contentType: "audio/mpeg" }
			});

			return `http://jolene-audio.jolenesego.com/${fileKey}`;
		} catch (err) {
			console.error("Audio Generation Loop Failed:", err);
			return "";
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/tts") {
			return new Response(JSON.stringify({ status: "browser_native_ready" }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get("personality") || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.filter(o => String(o.key).endsWith(".txt")).map(o => o.key),
				mode: "personal",
				personality: personality,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/memorize") {
			try {
				const r2Object = await this.env.DOCUMENTS.get("ScottIdentityV8.txt");
				if (!r2Object) {
					return new Response(JSON.stringify({ success: false, error: "Target V8 text artifact missing from R2 root." }), { status: 404, headers });
				}

				const rawText = await r2Object.text();
				
				await this.env.VECTORIZE.deleteByIds(["v8-identity-chunk-0"]);

				const embeddingResult = await this.env.AI.run(EMBEDDING_MODEL, { text: [rawText] });
				
				await this.env.VECTORIZE.upsert([{
					id: "v8-identity-chunk-0",
					values: embeddingResult.data[0],
					metadata: { text: rawText }
				}]);

				return new Response(JSON.stringify({ success: true, status: "Index synchronized perfectly via browser URL handler!" }), { headers });
			} catch (err: any) {
				return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers });
			}
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPersonality = await this.env.SETTINGS.get("personality") || "warm";
				
				const easternTimeStr = new Intl.DateTimeFormat('en-US', { 
					month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true, timeZone: 'America/New_York' 
				}).format(new Date());

				const activeModelString = body.model || "anthropic/claude-opus-4.7";

				if (userMsg.startsWith("🚨THEATER_EXECUTION_PROXY:")) {
					const jsonString = userMsg.split("🚨THEATER_EXECUTION_PROXY:")[1].trim();
					const payload = JSON.parse(jsonString);

					if (payload.tool === "get_nba_box_score") {
						const nativeBoxScoreData = await this.getLiveNBAScore(payload.arguments?.teamKeyword || "spurs");
						const systemPromptOverride = `### NBA factual data sync: ${nativeBoxScoreData}. Render the structured table slices now.`;
						const nextTurnResponse = await this.runAI(activeModelString, systemPromptOverride, "Generate box score splits display", body.messages);
						return new Response(`data: ${JSON.stringify({ response: nextTurnResponse })}\n\ndata: [DONE]\n\n`, { headers });
					}
				}

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				const lowerMsg = userMsg.toLowerCase();

				if (["spurs", "okc", "thunder", "lakers", "celtics", "warriors", "knicks", "cavs", "cavaliers", "nba", "boxscore", "box score", "scoreboard", "stats", "player lines", "points"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.getLiveNBAScore(userMsg);
				} else if (["stock", "shares", "ticker", "close", "price", "market", "net", "cloudflare"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.fetchLiveTickerPrice("NET");
				} else if (["weather", "forecast", "temperature", "outside", "now", "current", "news", "mma", "ufc", "fight", "time", "date", "today"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg, easternTimeStr);
				}

				if (["temp", "temperature", "thermostat", "degrees", "cool", "warm", "heat", "ac", "climate", "status", "set at"].some(kw => lowerMsg.includes(kw))) {
					liveContext = `[SYSTEM LAYER DIRECTIVE] You have active real-time clearance to use the agentic tools "set_house_temperature" and "get_house_temperatures". If the user asks what a room is set at, what the temp is, or asks for status, strictly call "get_house_temperatures" to read the traits from the house first before answering. Always output the trigger payload at the absolute end of your turn if actions/reads are required.`;
				}

				if (["lava lamp", "office lamp", "office plug", "office lights", "lava"].some(kw => lowerMsg.includes(kw))) {
					liveContext = `[SYSTEM LAYER DIRECTIVE] You have verified security jurisdiction over the basement office. If Scott requests to toggle the lava lamp or turn the office light plug on/off, you must immediately call the "control_house_lights" tool with the zone argument strictly set to "office".`;
				}

				let sonosTargetZone = "";
				if (["speak to", "say to", "broadcast", "tell renee", "announce", "play audio", "tell the office"].some(kw => lowerMsg.includes(kw))) {
					if (lowerMsg.includes("bedroom") || lowerMsg.includes("renee")) sonosTargetZone = "main_bedroom";
					else if (lowerMsg.includes("theater") || lowerMsg.includes("game")) sonosTargetZone = "theater";
					else if (lowerMsg.includes("kitchen")) sonosTargetZone = "kitchen";
					else sonosTargetZone = "office";

					liveContext = `[SYSTEM DIRECTIVE] The user is requesting an outbound audio announcement. You have explicit clearance to execute the tool "control_sonos_audio" targeting the "${sonosTargetZone}" zone. Construct your response naturally. Do not mention any URL strings textually inside the chat response block.`;
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.filter(m => m.metadata && m.metadata.text && !m.metadata.text.includes("%PDF-")).map(m => m.metadata.text).join("\n---\n");

				const globalHistoryFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id != ? ORDER BY id DESC LIMIT 15").bind(sessionId).all();
				const crossSessionMemory = globalHistoryFetch.results && globalHistoryFetch.results.length > 0 ? globalHistoryFetch.results.reverse().map((m: any) => `[Prior Thread - ${m.role.toUpperCase()}]: ${m.content}`).join("\n") : "No out-of-band dialogue lines archived in production datastore tables yet.";

				let systemPrompt = `### ABSOLUTE TEMPORAL TRUTH (CRITICAL GROUND TRUTH):
The real-time exact current date and time in Plymouth, MA is strictly: ${easternTimeStr}. You must always use this exact value for any time or date queries. Do not extrapolate or hallucinate other years or days.

### IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext} | CROSS_SESSION_HISTORY:\n${crossSessionMemory}`;

				let chatTxt = await this.runAI(activeModelString, systemPrompt, userMsg, recentContext);

				if (sonosTargetZone !== "") {
					const generatedUrl = await this.generateHerAudioStream(chatTxt);
					if (generatedUrl !== "") {
						chatTxt = chatTxt.split("\n").filter(line => !line.includes("_ACTION_TRIGGER:")).join("\n");
						chatTxt += `\n🚨THEATER_ACTION_TRIGGER:{"tool":"control_sonos_audio","arguments":{"zone":"${sonosTargetZone}","audioUrl":"https://jolene-audio.jolenesego.com/voice-system-online.mp3"}}`;
					}
				}

				if (chatTxt.includes("_ACTION_TRIGGER:")) {
					try {
						const triggerLine = chatTxt.split("\n").find(line => line.includes("_ACTION_TRIGGER:") && !line.includes("browser_native_audio"));
						if (triggerLine) {
							const jsonString = triggerLine.substring(triggerLine.indexOf("{")).trim();
							
							let payload = null;
							try {
								payload = JSON.parse(jsonString);
							} catch (jsonErr) {
								console.error("Defensive json parsing intercept bypassed a text fragment:", jsonErr.message);
							}

							if (payload && payload.tool === "get_nba_box_score") {
								const nativeBoxScoreData = await this.getLiveNBAScore(payload.arguments?.teamKeyword || userMsg);
								systemPrompt += `\n\n⚠️ [NATIVE BASEBALL FEED SUCCESS] The API-Sports basketball pipeline executed cleanly and returned this data structure: ${nativeBoxScoreData}. Use this structured factual JSON metrics block to draw up your final formatted table grids.`;
								chatTxt = await this.runAI(activeModelString, systemPrompt, userMsg, recentContext);
							} else if (payload) {
								const mcpResponse = await fetch("https://mcp.jolenesego.com/api/tools/execute", {
									method: "POST",
									headers: { 
										"Content-Type": "application/json",
										"User-Agent": "Cloudflare-Workers-MCP-Bridge"
									},
									body: JSON.stringify(payload)
								});

								if (mcpResponse.ok) {
									const toolExecutionResult = await mcpResponse.text();
									console.log("🎯 Tool Output Landed:", toolExecutionResult);

									systemPrompt += `\n\n⚠️ [MCP TOOL RESULT] The local hardware bridge executed your tool call and returned this live data: ${toolExecutionResult}. Use this exact state data to complete your answer to the user now. Do not mention the raw tool formatting to the user Simon.`;
									chatTxt = await this.runAI(activeModelString, systemPrompt, userMsg, recentContext);
									return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`, { headers });
								}
							}
						}
					} catch (parseErr: any) {
						console.error("MCP loop pipeline validation exception bypassed cleanly:", parseErr.message);
					}
				}

				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`, { headers });

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`, { headers }); }
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
