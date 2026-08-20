export async function collectPostFromPage(options = {}) {
  const API_BASE =
    "/xe.community.community_service/small_community";
  const PAGE_SIZE = 10;
  const MAX_PAGES = 500;

  const currentUrl = new URL(options.url || globalThis.location.href);
  const requestOrigin = options.origin || currentUrl.origin;
  const requestFetch = options.fetch || globalThis.fetch;
  const documentTitle = options.documentTitle ?? globalThis.document?.title ?? "";

  if (currentUrl.pathname.includes("/sign_in")) {
    throw new Error("登录状态已失效，请先重新登录鹅圈子。");
  }

  const pathMatch = currentUrl.pathname.match(/^\/([^/]+)\/feed_detail/);
  const communityId = pathMatch?.[1];
  const feedsId = currentUrl.searchParams.get("feeds_id");
  const appId = currentUrl.searchParams.get("app_id");

  if (!communityId || !feedsId || !appId) {
    throw new Error("当前不是有效的鹅圈子帖子详情页。");
  }

  async function requestJson(endpoint, params) {
    const url = new URL(`${API_BASE}/${endpoint}`, requestOrigin);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, item);
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await requestFetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`请求失败：${response.status} ${endpoint}`);
    }

    const payload = await response.json();
    if (payload.code !== 0) {
      throw new Error(payload.msg || `鹅圈子接口返回错误：${endpoint}`);
    }
    return payload.data;
  }

  const detailData = await requestJson("h5_feeds_detail", {
    feeds_id: feedsId,
    community_id: communityId,
    app_id: appId,
    comment_order: "desc",
    page: 1,
    page_size: PAGE_SIZE,
    comment_order_filed: "created_at",
    reply_limit: 2,
  });

  const feed = detailData.feedsDetail;
  if (!feed?.id) throw new Error("未能读取帖子详情。");

  const topLevelComments = [];
  const seenCommentIds = new Set();
  let totalTopLevelComments = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const relation = page === 1 ? ["comment", "praise"] : ["comment"];
    const pageData = await requestJson("get_comment_praise_list", {
      app_id: appId,
      community_id: communityId,
      feeds_id: feedsId,
      page,
      page_size: PAGE_SIZE,
      reply_limit: 2,
      order_type: 1,
      with_relation: relation,
    });

    const commentList = pageData.comment_list || { list: [], total_count: 0 };
    const batch = Array.isArray(commentList.list) ? commentList.list : [];
    totalTopLevelComments = Number(commentList.total_count || 0);

    for (const comment of batch) {
      if (!seenCommentIds.has(comment.id)) {
        seenCommentIds.add(comment.id);
        topLevelComments.push(comment);
      }
    }

    if (topLevelComments.length >= totalTopLevelComments || batch.length === 0) break;
    if (page === MAX_PAGES) {
      throw new Error("评论数量超过安全分页上限，导出已停止以避免遗漏。");
    }
  }

  for (const comment of topLevelComments) {
    const replyInfo = comment.reply_comment_list || { list: [], total_count: 0 };
    const replies = Array.isArray(replyInfo.list) ? [...replyInfo.list] : [];
    const replyIds = new Set(replies.map((reply) => reply.id));
    const replyTotal = Number(replyInfo.total_count || replies.length);

    for (let page = 1; replies.length < replyTotal && page <= MAX_PAGES; page += 1) {
      const replyData = await requestJson("reply_comment_list/1.0.0", {
        app_id: appId,
        community_id: communityId,
        feeds_id: feedsId,
        main_comment_id: comment.id,
        page,
        page_size: PAGE_SIZE,
        order_type: 3,
      });
      const batch = Array.isArray(replyData.list) ? replyData.list : [];
      for (const reply of batch) {
        if (!replyIds.has(reply.id)) {
          replyIds.add(reply.id);
          replies.push(reply);
        }
      }

      if (batch.length === 0) break;
      if (page === MAX_PAGES) {
        throw new Error(`评论 ${comment.id} 的回复超过安全分页上限。`);
      }
    }

    if (replies.length < replyTotal) {
      throw new Error(`评论 ${comment.id} 的回复未能完整读取，请稍后重试。`);
    }

    comment.reply_comment_list = { list: replies, total_count: replyTotal };
  }

  const resources = [];
  const resourceUrls = new Set();

  function safeResourceName(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function addResource(candidate, kind, ownerId = "post") {
    if (!candidate) return "";
    const url =
      typeof candidate === "string"
        ? candidate
        : candidate.showUrl || candidate.url || candidate.src || candidate.file_url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || resourceUrls.has(url)) {
      return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
    }

    resourceUrls.add(url);
    resources.push({
      url,
      kind,
      ownerId: String(ownerId),
      name: safeResourceName(candidate.name || candidate.file_name),
      mediaType: safeResourceName(candidate.type || candidate.fileType),
      expectedSize: Number(candidate.size || candidate.file_size || 0),
    });
    return url;
  }

  function scanResourceTree(
    value,
    kind,
    ownerId,
    seen = new WeakSet(),
    collectedUrls = null,
  ) {
    if (!value) return;
    if (typeof value === "string") {
      const attributePattern = /(?:src|href)=["'](https?:\/\/[^"']+)["']/gi;
      for (const match of value.matchAll(attributePattern)) {
        const url = addResource(match[1], kind, ownerId);
        if (url) collectedUrls?.add(url);
      }
      if (/^https?:\/\//i.test(value)) {
        const url = addResource(value, kind, ownerId);
        if (url) collectedUrls?.add(url);
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (value.url || value.showUrl || value.src || value.file_url) {
      const url = addResource(value, kind, ownerId);
      if (url) collectedUrls?.add(url);
    }
    for (const child of Object.values(value)) {
      scanResourceTree(child, kind, ownerId, seen, collectedUrls);
    }
  }

  for (const file of Array.isArray(feed.file_json) ? feed.file_json : []) {
    addResource(file, "attachment", feed.id);
  }

  const postMediaFields = [
    feed.content,
    feed.mix_content,
    feed.org_content,
    feed.image_json,
    feed.video_json,
    feed.audio_json,
    feed.resource_json,
    feed.feed_tts_audio,
  ];
  for (const field of postMediaFields) scanResourceTree(field, "post-media", feed.id);

  function normalizeComment(comment, isReply = false) {
    const commentResources = new Set();
    scanResourceTree(
      comment.comment_resource,
      isReply ? "reply-media" : "comment-media",
      comment.id,
      new WeakSet(),
      commentResources,
    );

    const replies = Array.isArray(comment.reply_comment_list?.list)
      ? comment.reply_comment_list.list.map((reply) => normalizeComment(reply, true))
      : [];

    return {
      id: String(comment.id),
      author: comment.nick_name || "匿名用户",
      role: comment.role_name || "",
      text: comment.comment || "",
      createdAt: comment.created_at || "",
      displayTime: comment.show_time || "",
      location: comment.ip_place || "",
      likeCount: Number(comment.praise_cnt || comment.zan_num || 0),
      resources: [...commentResources],
      replies,
      replyTo: comment.reply_nick_name || "",
      replyToId: comment.reply_comment_id ? String(comment.reply_comment_id) : "",
      mainCommentId: comment.main_comment_id ? String(comment.main_comment_id) : "",
    };
  }

  const comments = topLevelComments.map((comment) => normalizeComment(comment));

  // 标记“回复的回复”中被回复评论缺失的情况（已被删除或接口未返回），
  // 便于导出时提示读者：该回复针对的问题原文未能获取。
  for (const comment of comments) {
    const knownIds = new Set([comment.id, ...comment.replies.map((reply) => reply.id)]);
    for (const reply of comment.replies) {
      if (reply.replyToId && !knownIds.has(reply.replyToId)) {
        reply.replyMissing = true;
      }
    }
  }
  const stripHtml = (html) =>
    String(html || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  const postText =
    feed.content?.text || feed.mix_content?.text || stripHtml(feed.org_content) || "";

  // 问答帖（feeds_type=10）：作者以回答形式发布的帖子会在 content 内联被回复的问题
  // （questioner_info/question_title/question_text），或通过 feed_info 嵌套原始问题帖。
  // 需要把问题一并导出，否则读者看不到回答所针对的内容。
  // 问题帖本身（提问者即帖子作者，content 无 questioner_info/question_text）不受影响。
  // 注意：本函数通过 chrome.scripting.executeScript 注入页面执行，所有辅助函数
  // 必须定义在 collectPostFromPage 函数体内部，不能放在模块顶层。
  function extractQuestion(targetFeed) {
    const content = targetFeed.content || {};
    const nestedContent = targetFeed.feed_info?.content || {};
    const askerInfo = content.questioner_info || nestedContent.questioner_info || null;
    const title = content.question_title || nestedContent.question_title || "";
    const text = content.question_text || nestedContent.question_text || "";
    if (!askerInfo && !text) return null;
    return {
      asker: askerInfo?.nick_name || "",
      title,
      text,
    };
  }

  const question = extractQuestion(feed);

  // 标题 fallback 链：API 标题 → 问答帖的问题标题 → 正文第一行（截断 40 字）→ 帖子-ID。
  // 问答帖（回答帖）的 feed.title 常为空，若直接落到正文第一行会取到作者回答的
  // 整段长句，不适合做标题；问题标题才是帖子主题。
  function truncateTitle(value, maxLength = 40) {
    const chars = Array.from(String(value || "").trim());
    if (chars.length <= maxLength) return chars.join("");
    return `${chars.slice(0, maxLength).join("")}…`;
  }

  const fallbackTitle =
    question?.title ||
    truncateTitle(postText.split(/\r?\n/).find(Boolean) || "") ||
    `帖子-${feed.id}`;

  const canonicalUrl = new URL(`/${communityId}/feed_detail`, currentUrl.origin);
  canonicalUrl.searchParams.set("feeds_id", feedsId);
  canonicalUrl.searchParams.set("app_id", appId);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceUrl: canonicalUrl.href,
    community: {
      id: communityId,
      title: feed.community_title || documentTitle.split(" - ").at(-1) || "鹅圈子",
    },
    post: {
      id: String(feed.id),
      title: feed.title || fallbackTitle,
      text: postText,
      question,
      author: feed.nick_name || "匿名用户",
      createdAt: feed.created_at || "",
      displayTime: feed.show_time || "",
      location: feed.ip_place || "",
      likeCount: Number(feed.zan_num || 0),
      commentCount: Number(feed.comment_count || 0),
      tags: Array.isArray(feed.tags) ? feed.tags : [],
      attachments: (Array.isArray(feed.file_json) ? feed.file_json : []).map((file) => ({
        name: file.name || file.file_name || "附件",
        url: file.showUrl || file.url || file.file_url || "",
        size: Number(file.size || file.file_size || 0),
        type: file.fileType || file.type || "",
      })),
    },
    comments,
    resources,
  };
}
