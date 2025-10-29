import { AtpAgent } from "@atproto/api";
import "dotenv/config";

const LISTIFICATIONS_DID = "did:plc:yatb2t26fw7u3c7qcacq7rje";
const LISTIFICATIONS_HANDLE = "listifications.app";

interface MonitorAccount {
  handle: string;
  password: string;
}

interface SessionData {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
  expires: number;
}

interface AuthenticatedAccount {
  account: MonitorAccount;
  agent: AtpAgent;
  sessionValid: boolean;
}

class BlockWatcher {
  private monitorAccounts: MonitorAccount[] = [];
  private blockersListUri: string = "";
  private listAgent?: AtpAgent;
  private authenticatedAccounts: AuthenticatedAccount[] = [];
  private pollInterval: number = 30000;
  private dryRun: boolean = false;
  private backfillHours: number = 24;
  private sessionsFile = "/usr/src/app/logs/sessions.json";
  private processedMessages = new Set<string>();
  private processedMessagesFile = "/usr/src/app/logs/processed_messages.json";

  constructor() {
    this.loadConfig();
    this.loadProcessedMessages();
  }

  private async authenticateAllAccounts() {
    const listAccount = {
      handle: process.env.LIST_ACCOUNT_HANDLE || "",
      password: process.env.LIST_ACCOUNT_PASSWORD || ""
    };
    
    // Load existing sessions
    const savedSessions = await this.loadSessions();
    
    // Authenticate list account
    const listAuth = await this.authenticateAccount(listAccount, savedSessions);
    if (listAuth.sessionValid) {
      this.listAgent = listAuth.agent;
      console.log(`✓ List account authenticated: ${listAccount.handle}`);
    } else {
      console.error(`✗ List account failed to authenticate: ${listAccount.handle}`);
    }
    
    // Authenticate monitor accounts
    const failedAccounts: string[] = [];
    for (const account of this.monitorAccounts) {
      const auth = await this.authenticateAccount(account, savedSessions);
      if (auth.sessionValid) {
        this.authenticatedAccounts.push(auth);
        console.log(`✓ Monitor account authenticated: ${account.handle}`);
      } else {
        failedAccounts.push(account.handle);
        console.error(`✗ Monitor account failed to authenticate: ${account.handle}`);
      }
    }
    
    // Save updated sessions
    await this.saveSessions();
    
    // Report status
    const successCount = this.authenticatedAccounts.length;
    const totalCount = this.monitorAccounts.length;
    console.log(`Authentication complete: ${successCount}/${totalCount} monitor accounts active`);
    
    // Manual test of the block message processing
    console.log("Testing block message processing...");
    await this.processNotification("@abolition.bsky.social has blocked you", "did:plc:c5d5thu6uwhb5odxgk7ejvni");
    
    if (failedAccounts.length > 0) {
      console.warn(`⚠️  Unmonitored accounts (rate limited or invalid credentials): ${failedAccounts.join(", ")}`);
      console.warn(`These accounts will be retried on next restart`);
    }
  }

  private async authenticateAccount(account: MonitorAccount, savedSessions: Record<string, SessionData>): Promise<AuthenticatedAccount> {
    const agent = new AtpAgent({ 
      service: "https://bsky.social"
    });
    
    // Try to restore session first
    const savedSession = savedSessions[account.handle];
    if (savedSession && savedSession.expires > Date.now()) {
      try {
        agent.session = {
          accessJwt: savedSession.accessJwt,
          refreshJwt: savedSession.refreshJwt,
          handle: savedSession.handle,
          did: savedSession.did
        };
        
        // Test the session with a simple API call
        await agent.getProfile({ actor: savedSession.did });
        
        return { account, agent, sessionValid: true };
      } catch (error) {
        console.log(`Cached session expired for ${account.handle}, attempting fresh login`);
      }
    }
    
    // Fresh login if no valid session
    try {
      await agent.login({
        identifier: account.handle,
        password: account.password
      });
      
      // Save the new session
      if (agent.session) {
        savedSessions[account.handle] = {
          accessJwt: agent.session.accessJwt,
          refreshJwt: agent.session.refreshJwt,
          handle: agent.session.handle,
          did: agent.session.did,
          expires: Date.now() + (23 * 60 * 60 * 1000) // 23 hours
        };
      }
      
      return { account, agent, sessionValid: true };
    } catch (error) {
      return { account, agent, sessionValid: false };
    }
  }

  private async loadSessions(): Promise<Record<string, SessionData>> {
    try {
      const data = await Bun.file(this.sessionsFile).text();
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async loadProcessedMessages() {
    try {
      const data = await Bun.file(this.processedMessagesFile).text();
      const messageIds = JSON.parse(data);
      this.processedMessages = new Set(messageIds);
    } catch {
      this.processedMessages = new Set();
    }
  }

  private async saveProcessedMessages() {
    try {
      const messageIds = Array.from(this.processedMessages);
      await Bun.write(this.processedMessagesFile, JSON.stringify(messageIds, null, 2));
    } catch (error) {
      console.warn("Failed to save processed messages:", error.message);
    }
  }

  private async saveSessions() {
    const sessions: Record<string, SessionData> = {};
    
    // Save list account session
    if (this.listAgent?.session) {
      const handle = process.env.LIST_ACCOUNT_HANDLE || "";
      sessions[handle] = {
        accessJwt: this.listAgent.session.accessJwt,
        refreshJwt: this.listAgent.session.refreshJwt,
        handle: this.listAgent.session.handle,
        did: this.listAgent.session.did,
        expires: Date.now() + (23 * 60 * 60 * 1000)
      };
    }
    
    // Save monitor account sessions
    for (const auth of this.authenticatedAccounts) {
      if (auth.agent.session) {
        sessions[auth.account.handle] = {
          accessJwt: auth.agent.session.accessJwt,
          refreshJwt: auth.agent.session.refreshJwt,
          handle: auth.agent.session.handle,
          did: auth.agent.session.did,
          expires: Date.now() + (23 * 60 * 60 * 1000)
        };
      }
    }
    
    try {
      // Ensure logs directory exists and is writable
      await Bun.write("/usr/src/app/logs/.test", "test");
      await Bun.write(this.sessionsFile, JSON.stringify(sessions, null, 2));
      console.log("Sessions saved successfully");
    } catch (error) {
      console.warn("Failed to save sessions (will retry on next restart):", error.message);
    }
  }

  private normalizeListUri(uri: string): string {
    if (!uri) return uri;
    
    // Convert web URL to AT-URI
    // https://bsky.app/profile/did:plc:abc123/lists/3l2ujiym5dm2z
    // -> at://did:plc:abc123/app.bsky.graph.list/3l2ujiym5dm2z
    const webUrlMatch = uri.match(/https:\/\/bsky\.app\/profile\/(did:[^/]+)\/lists\/([^/?]+)/);
    if (webUrlMatch) {
      const [, did, rkey] = webUrlMatch;
      return `at://${did}/app.bsky.graph.list/${rkey}`;
    }
    
    // Already AT-URI format or invalid
    return uri;
  }

  private loadConfig() {
    const monitorAccountsRaw = process.env.MONITOR_ACCOUNTS || "";
    this.monitorAccounts = monitorAccountsRaw
      .split(",")
      .filter(entry => entry.trim() && entry.includes(":"))
      .map(entry => {
        const parts = entry.trim().split(":");
        const handle = parts.slice(0, -1).join(":"); // Handle DIDs with multiple colons
        const password = parts[parts.length - 1];
        return { handle: handle.trim(), password: password.trim() };
      });

    // Add list account to monitor accounts if enabled
    const monitorListAccount = process.env.MONITOR_LIST_ACCOUNT === "true";
    if (monitorListAccount) {
      const listHandle = process.env.LIST_ACCOUNT_HANDLE || "";
      const listPassword = process.env.LIST_ACCOUNT_PASSWORD || "";
      if (listHandle && listPassword) {
        this.monitorAccounts.unshift({ handle: listHandle, password: listPassword });
      }
    }

    this.blockersListUri = this.normalizeListUri(process.env.BLOCKERS_LIST_URI || "");
    this.pollInterval = parseInt(process.env.POLL_INTERVAL_SECONDS || "30") * 1000;
    this.dryRun = process.env.DRY_RUN === "true";
    this.backfillHours = parseInt(process.env.BACKFILL_HOURS || "24");
  }

  async start() {
    if (this.monitorAccounts.length === 0) {
      console.log("No monitor accounts configured");
      return;
    }

    if (!this.blockersListUri) {
      console.log("No BLOCKERS_LIST_URI configured");
      return;
    }

    console.log(`Block watcher monitoring ${this.monitorAccounts.length} accounts`);
    console.log(`Poll interval: ${this.pollInterval/1000}s, Dry run: ${this.dryRun}, Backfill: ${this.backfillHours}h`);
    
    if (this.dryRun) {
      console.log("[DRY RUN] Skipping all API calls - configuration test mode");
    } else {
      // Authenticate all accounts with session persistence
      await this.authenticateAllAccounts();
      
      // Initial backfill check for authenticated accounts
      await this.backfillAllAccounts();
    }
    
    // Start health server
    this.startHealthServer();
    
    // Poll at configured interval
    setInterval(() => this.checkAllAccounts(), this.pollInterval);
    
    // Initial check
    await this.checkAllAccounts();
  }

  private async checkAllAccounts() {
    if (this.dryRun) {
      console.log("[DRY RUN] Would check all accounts for block notifications");
      return;
    }
    
    for (const auth of this.authenticatedAccounts) {
      try {
        await this.checkAuthenticatedAccount(auth);
      } catch (error) {
        console.error(`Error checking ${auth.account.handle}:`, error);
      }
    }
  }

  private async checkAuthenticatedAccount(auth: AuthenticatedAccount) {
    const { account, agent } = auth;

    try {
      // Try DMs first (fallback to notifications if DM API unavailable)
      let convos;
      try {
          // Direct XRPC call to chat service like third-party clients
        const response = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=10', {
          headers: {
            'Authorization': `Bearer ${agent.session?.accessJwt}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        convos = await response.json();
      } catch (error) {
        console.log(`DM API failed: ${error.message}`);
        throw new Error("DM API unavailable");
      }
      
      if (!convos || !convos.convos) {
        throw new Error("DM API unavailable");
      }
      
      const listificationsConvo = convos.convos.find(
        convo => convo.members.some(member => 
          member.did === LISTIFICATIONS_DID || 
          member.handle?.includes('listifications')
        )
      );

      if (listificationsConvo) {
        const msgResponse = await fetch(`https://api.bsky.chat/xrpc/chat.bsky.convo.getMessages?convoId=${listificationsConvo.id}&limit=50`, {
          headers: {
            'Authorization': `Bearer ${agent.session?.accessJwt}`,
            'Content-Type': 'application/json'
          }
        });
        
        const messages = await msgResponse.json();

        let newBlocksFound = 0;
        for (const message of messages.messages || []) {
          if (message.sender.did === LISTIFICATIONS_DID) {
            const messageId = `${message.id || message.sentAt}`;
            if (!this.processedMessages.has(messageId)) {
              console.log(`Processing new listifications message: ${message.text}`);
              this.processedMessages.add(messageId);
              await this.saveProcessedMessages();
              await this.processNotification(message.text, account.handle);
              newBlocksFound++;
            }
          }
        }
        
        if (newBlocksFound === 0) {
          console.log(`No new blocks for ${account.handle}`);
        }
      }
    } catch {
      // Fallback to notifications
      try {
        console.log(`Checking notifications for ${account.handle}`);
        const notifications = await agent.app.bsky.notification.listNotifications({ limit: 100 });
        
        let foundListifications = false;
        console.log(`Checking ${notifications.data.notifications.length} notifications for ${account.handle}`);
        
        for (const notif of notifications.data.notifications) {
          const authorInfo = `${notif.author.handle || notif.author.did}`;
          console.log(`Notification from ${authorInfo}: ${notif.reason}`);
          
          // Check for listifications with multiple possible identifiers
          const isListifications = notif.author.did === LISTIFICATIONS_DID || 
                                 notif.author.handle === LISTIFICATIONS_HANDLE ||
                                 notif.author.handle === 'listifications' ||
                                 authorInfo.includes('listifications');
          
          // Debug: log any notification that might be listifications
          if (authorInfo.toLowerCase().includes('listif') || authorInfo.includes('listifications')) {
            console.log(`FOUND LISTIFICATIONS: ${authorInfo} (${notif.author.did}) - ${notif.reason}`);
            if (notif.reason === 'mention') {
              const post = notif.record as any;
              if (post?.text) {
                console.log(`LISTIFICATIONS MESSAGE: ${post.text}`);
              }
            }
          }
          
          if (isListifications) {
            foundListifications = true;
            console.log(`Found listifications notification: ${notif.reason}`);
            
            if (notif.reason === "mention") {
              const post = notif.record as any;
              if (post?.text) {
                console.log(`Processing mention: ${post.text.substring(0, 100)}...`);
                await this.processNotification(post.text, account.handle);
              }
            }
          }
        }
        
        if (!foundListifications) {
          console.log(`No listifications notifications found for ${account.handle}`);
        }
      } catch (error) {
        console.error(`Failed to check notifications for ${account.handle}:`, error);
      }
    }
  }

  private async backfillAllAccounts() {
    if (this.dryRun) {
      console.log(`[DRY RUN] Would backfill last ${this.backfillHours} hours for ${this.monitorAccounts.length} accounts`);
      return;
    }
    
    console.log(`Starting backfill for last ${this.backfillHours} hours...`);
    const cutoffTime = new Date(Date.now() - (this.backfillHours * 60 * 60 * 1000));
    
    for (const auth of this.authenticatedAccounts) {
      try {
        await this.backfillAuthenticatedAccount(auth, cutoffTime);
      } catch (error) {
        console.error(`Error backfilling ${auth.account.handle}:`, error);
      }
    }
    console.log("Backfill complete");
  }

  private async backfillAuthenticatedAccount(auth: AuthenticatedAccount, cutoffTime: Date) {
    const { account, agent } = auth;

    try {
      // Check DMs for backfill (fallback to notifications if DM API unavailable)
      let convos;
      try {
        const response = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=10', {
          headers: {
            'Authorization': `Bearer ${agent.session?.accessJwt}`,
            'Content-Type': 'application/json'
          }
        });
        
        convos = await response.json();
      } catch (error) {
        console.log(`DM API not available for ${account.handle}, skipping DM backfill: ${error.message}`);
        return;
      }
      
      if (!convos || !convos.convos) {
        console.log(`DM API not available for ${account.handle}, skipping DM backfill`);
        return;
      }
      const listificationsConvo = convos.convos.find(
        convo => convo.members.some(member => member.did === LISTIFICATIONS_DID)
      );

      if (listificationsConvo) {
        // Get more messages for backfill
        const msgResponse = await fetch(`https://api.bsky.chat/xrpc/chat.bsky.convo.getMessages?convoId=${listificationsConvo.id}&limit=100`, {
          headers: {
            'Authorization': `Bearer ${agent.session?.accessJwt}`,
            'Content-Type': 'application/json'
          }
        });
        
        const messages = await msgResponse.json();

        for (const message of messages.messages || []) {
          if (message.sender.did === LISTIFICATIONS_DID) {
            const messageTime = new Date(message.sentAt);
            if (messageTime >= cutoffTime) {
              const messageId = `${message.id || message.sentAt}`;
              this.processedMessages.add(messageId); // Mark as processed during backfill
              await this.processNotification(message.text, account.handle, true);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to backfill DMs for ${account.handle}:`, error);
    }
  }

  private async processNotification(text: string, targetHandle: string, isBackfill = false) {
    console.log(`Processing notification text: "${text}" for ${targetHandle}`);
    
    const blockPattern = /@([\w.-]+)\s+has blocked you/i;
    const modListPattern = /@([\w.-]+)\s+has added you to the "[^"]*"\s+moderation list/i;
    
    const blockMatch = text.match(blockPattern);
    const modListMatch = text.match(modListPattern);
    
    console.log(`Block match: ${blockMatch ? blockMatch[1] : 'none'}, Mod list match: ${modListMatch ? modListMatch[1] : 'none'}`);
    
    if (!blockMatch && !modListMatch) {
      return;
    }
    
    const offenderHandle = blockMatch ? blockMatch[1] : modListMatch![1];
    const action = blockMatch ? "blocked" : "added to moderation list";
    
    try {
      // Resolve offender handle to DID
      const resolved = await this.listAgent!.com.atproto.identity.resolveHandle({ 
        handle: offenderHandle 
      });
      const offenderDid = resolved.data.did;
      
      const prefix = isBackfill ? "[BACKFILL]" : "";
      console.log(`${prefix} Detected: ${offenderHandle} (${offenderDid}) ${action} ${targetHandle}`);
      
      // Add to blockers list
      await this.addToBlockersList(offenderDid);
      
    } catch (error) {
      console.error(`Failed to resolve handle ${offenderHandle}:`, error);
    }
  }

  private async addToBlockersList(userDid: string) {
    if (!this.listAgent) {
      console.error("No list agent available");
      return;
    }
    
    console.log(`Attempting to add ${userDid} to blockers list: ${this.blockersListUri}`);
    
    // Check if user is already in the list
    try {
      const list = await this.listAgent.app.bsky.graph.getList({
        list: this.blockersListUri,
        limit: 100
      });
      
      const alreadyInList = list.data.items.some(item => item.subject.did === userDid);
      if (alreadyInList) {
        console.log(`${userDid} already in blockers list, skipping`);
        return;
      }
    } catch (error) {
      console.error(`Failed to check if user in list:`, error.message);
    }
    
    if (this.dryRun) {
      console.log(`[DRY RUN] Would add ${userDid} to blockers list`);
      return;
    }
    
    try {
      await this.listAgent.app.bsky.graph.listitem.create(
        { repo: this.listAgent.did! },
        {
          subject: userDid,
          list: this.blockersListUri,
          createdAt: new Date().toISOString(),
        }
      );
      
      console.log(`Added ${userDid} to blockers list`);
    } catch (error) {
      console.error(`Failed to add ${userDid} to list:`, error);
    }
  }

  private startHealthServer() {
    const port = parseInt(process.env.PORT || "3000");
    
    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);
        
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({
            status: "ok",
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        return new Response("Not Found", { status: 404 });
      }
    });
    
    console.log(`Health server running on port ${port}`);
  }
}

const watcher = new BlockWatcher();
watcher.start().catch(console.error);