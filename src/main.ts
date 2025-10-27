import { Agent } from "@atproto/api";
import "dotenv/config";

const LISTIFICATIONS_DID = "did:plc:ea2eqamjmtuo6f4rvhl3g6ne";

interface MonitorAccount {
  handle: string;
  password: string;
}

class BlockWatcher {
  private monitorAccounts: MonitorAccount[] = [];
  private blockersListUri: string = "";
  private listAgent?: Agent;
  private pollInterval: number = 30000;
  private dryRun: boolean = false;
  private backfillHours: number = 24;

  constructor() {
    this.loadConfig();
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
      .filter(entry => entry.includes(":"))
      .map(entry => {
        const [handle, password] = entry.split(":");
        return { handle: handle.trim(), password: password.trim() };
      });

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

    // Create agent for managing the blockers list
    this.listAgent = new Agent({ service: "https://bsky.social" });
    await this.listAgent.login({
      identifier: process.env.LIST_ACCOUNT_HANDLE || "",
      password: process.env.LIST_ACCOUNT_PASSWORD || ""
    });

    console.log(`Block watcher monitoring ${this.monitorAccounts.length} accounts`);
    console.log(`Poll interval: ${this.pollInterval/1000}s, Dry run: ${this.dryRun}, Backfill: ${this.backfillHours}h`);
    
    // Start health server
    this.startHealthServer();
    
    // Initial backfill check
    await this.backfillAllAccounts();
    
    // Poll at configured interval
    setInterval(() => this.checkAllAccounts(), this.pollInterval);
    
    // Initial check
    await this.checkAllAccounts();
  }

  private async checkAllAccounts() {
    for (const account of this.monitorAccounts) {
      try {
        await this.checkAccount(account);
      } catch (error) {
        console.error(`Error checking ${account.handle}:`, error);
      }
    }
  }

  private async checkAccount(account: MonitorAccount) {
    const agent = new Agent({ service: "https://bsky.social" });
    await agent.login({ identifier: account.handle, password: account.password });

    try {
      // Try DMs first
      const convos = await agent.app.bsky.convo.listConvos({ limit: 10 });
      const listificationsConvo = convos.data.convos.find(
        convo => convo.members.some(member => member.did === LISTIFICATIONS_DID)
      );

      if (listificationsConvo) {
        const messages = await agent.app.bsky.convo.getMessages({
          convoId: listificationsConvo.id,
          limit: 50
        });

        for (const message of messages.data.messages) {
          if (message.sender.did === LISTIFICATIONS_DID) {
            await this.processNotification(message.text, account.handle);
          }
        }
      }
    } catch {
      // Fallback to mentions
      try {
        const notifications = await agent.app.bsky.notification.listNotifications({ limit: 50 });
        
        for (const notif of notifications.data.notifications) {
          if (notif.author.did === LISTIFICATIONS_DID && notif.reason === "mention") {
            const post = notif.record as any;
            if (post?.text) {
              await this.processNotification(post.text, account.handle);
            }
          }
        }
      } catch (error) {
        console.error(`Failed to check notifications for ${account.handle}:`, error);
      }
    }
  }

  private async backfillAllAccounts() {
    console.log(`Starting backfill for last ${this.backfillHours} hours...`);
    const cutoffTime = new Date(Date.now() - (this.backfillHours * 60 * 60 * 1000));
    
    for (const account of this.monitorAccounts) {
      try {
        await this.backfillAccount(account, cutoffTime);
      } catch (error) {
        console.error(`Error backfilling ${account.handle}:`, error);
      }
    }
    console.log("Backfill complete");
  }

  private async backfillAccount(account: MonitorAccount, cutoffTime: Date) {
    const agent = new Agent({ service: "https://bsky.social" });
    await agent.login({ identifier: account.handle, password: account.password });

    try {
      // Check DMs for backfill
      const convos = await agent.app.bsky.convo.listConvos({ limit: 10 });
      const listificationsConvo = convos.data.convos.find(
        convo => convo.members.some(member => member.did === LISTIFICATIONS_DID)
      );

      if (listificationsConvo) {
        // Get more messages for backfill
        const messages = await agent.app.bsky.convo.getMessages({
          convoId: listificationsConvo.id,
          limit: 100
        });

        for (const message of messages.data.messages) {
          if (message.sender.did === LISTIFICATIONS_DID) {
            const messageTime = new Date(message.sentAt);
            if (messageTime >= cutoffTime) {
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
    const blockPattern = /@([\w.-]+)\s+has blocked you/i;
    const modListPattern = /@([\w.-]+)\s+has added you to the "[^"]*"\s+moderation list/i;
    
    const blockMatch = text.match(blockPattern);
    const modListMatch = text.match(modListPattern);
    
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
    if (!this.listAgent) return;
    
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
      console.error(`Failed to check if user in list:`, error);
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