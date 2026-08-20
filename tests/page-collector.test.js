import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectPostFromPage } from "../src/page-collector.js";

// collectPostFromPage 通过 chrome.scripting.executeScript({ func }) 注入页面 MAIN world
// 执行：只有函数体本身会被序列化注入，模块顶层的其他函数/变量不会跟随。
// 若函数体引用了模块顶层标识符，注入执行时会抛 ReferenceError，导出报
// “页面没有返回帖子数据”。此测试防止此类回归。
test("collectPostFromPage is self-contained for chrome.scripting injection", async () => {
  const source = await readFile(new URL("../src/page-collector.js", import.meta.url), "utf8");
  const body = collectPostFromPage.toString();

  // 模块顶层声明的函数（行首无缩进的 function 声明）
  const topLevelFunctions = [...source.matchAll(/^function\s+(\w+)/gm)].map((m) => m[1]);
  const externalRefs = topLevelFunctions.filter(
    (name) => name !== "collectPostFromPage" && new RegExp(`\\b${name}\\b`).test(body),
  );
  assert.deepEqual(
    externalRefs,
    [],
    `collectPostFromPage 引用了模块顶层函数 ${externalRefs.join(", ")}，注入页面后会 ReferenceError`,
  );

  // 模块顶层 import 的绑定同样不可用
  assert.doesNotMatch(body, /\bimport\b/, "函数体内不应出现 import 语句");
});

test("collects paginated comments, replies and media without hidden identity fields", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;
  const requestedUrls = [];

  globalThis.location = new URL(
    "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-1&app_id=app-1",
  );
  globalThis.document = { title: "测试帖子 - 测试社群" };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedUrls.push(url);
    let data;

    if (url.pathname.endsWith("/h5_feeds_detail")) {
      data = {
        feedsDetail: {
          id: "feed-1",
          community_title: "测试社群",
          title: "测试帖子",
          nick_name: "作者",
          created_at: "2026-08-12 10:00:00",
          ip: "127.0.0.1",
          ip_place: "上海",
          zan_num: 2,
          comment_count: 4,
          tags: [],
          content: { text: "正文" },
          file_json: [
            { name: "报告.pdf", url: "https://cdn.myqcloud.com/report.pdf", size: 12 },
          ],
        },
      };
    } else if (url.pathname.endsWith("/get_comment_praise_list")) {
      const page = Number(url.searchParams.get("page"));
      data = {
        comment_list: {
          total_count: 2,
          list:
            page === 1
              ? [
                  {
                    id: 1,
                    nick_name: "评论者甲",
                    user_id: "hidden-user-id",
                    ip: "10.0.0.1",
                    ip_place: "浙江",
                    comment: "一级评论",
                    comment_resource: {
                      image: [
                        { name: "图.jpg", url: "https://cdn.myqcloud.com/comment.jpg" },
                        { name: "重复图.jpg", url: "https://cdn.myqcloud.com/shared.jpg" },
                      ],
                    },
                    reply_comment_list: {
                      total_count: 3,
                      list: [
                        {
                          id: 11,
                          nick_name: "回复者甲",
                          comment: "回复一",
                          main_comment_id: 1,
                          reply_comment_id: 1,
                        },
                      ],
                    },
                  },
                ]
              : [
                  {
                    id: 2,
                    nick_name: "评论者乙",
                    comment: "第二条",
                    comment_resource: {
                      image: [{ name: "重复图.jpg", url: "https://cdn.myqcloud.com/shared.jpg" }],
                    },
                    reply_comment_list: { total_count: 0, list: [] },
                  },
                ],
        },
      };
    } else if (url.pathname.endsWith("/reply_comment_list/1.0.0")) {
      data = {
        total_count: 3,
        list: [
          { id: 11, nick_name: "回复者甲", comment: "回复一", main_comment_id: 1, reply_comment_id: 1 },
          {
            id: 12,
            nick_name: "回复者乙",
            comment: "回复二",
            ip: "10.0.0.2",
            main_comment_id: 1,
            reply_comment_id: 11,
            reply_nick_name: "回复者甲",
          },
          {
            id: 13,
            nick_name: "作者",
            comment: "回答",
            main_comment_id: 1,
            reply_comment_id: 99,
            reply_nick_name: "提问者",
          },
        ],
      };
    } else {
      throw new Error(`Unexpected URL: ${url}`);
    }

    return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await collectPostFromPage();
    assert.equal(result.post.title, "测试帖子");
    assert.equal(result.comments.length, 2);
    assert.equal(result.comments[0].replies.length, 3);
    // 回复一级评论：无被回复者标注
    assert.equal(result.comments[0].replies[0].replyTo, "");
    assert.equal(result.comments[0].replies[0].replyToId, "1");
    assert.equal(result.comments[0].replies[0].mainCommentId, "1");
    // 回复的回复：提取被回复者昵称与评论 ID
    assert.equal(result.comments[0].replies[1].replyTo, "回复者甲");
    assert.equal(result.comments[0].replies[1].replyToId, "11");
    assert.equal(result.comments[0].replies[1].mainCommentId, "1");
    assert.equal(result.comments[0].replies[1].replyMissing, undefined);
    // 被回复的评论已缺失（如被删除）：标记 replyMissing
    assert.equal(result.comments[0].replies[2].replyTo, "提问者");
    assert.equal(result.comments[0].replies[2].replyToId, "99");
    assert.equal(result.comments[0].replies[2].replyMissing, true);
    assert.equal(result.resources.length, 3);
    assert.deepEqual(result.comments[1].resources, ["https://cdn.myqcloud.com/shared.jpg"]);
    assert.equal("ip" in result.comments[0], false);
    assert.equal("user_id" in result.comments[0], false);
    assert.equal(
      requestedUrls.some(
        (url) => url.pathname.endsWith("/get_comment_praise_list") && url.searchParams.get("page") === "2",
      ),
      true,
    );
    assert.equal(
      requestedUrls.some((url) => url.pathname.endsWith("/reply_comment_list/1.0.0")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});

test("collects an explicit detail URL while the current page is a feed list", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;
  const requestedUrls = [];

  globalThis.location = new URL("https://quanzi.xiaoe-tech.com/community-demo");
  globalThis.document = { title: "列表页 - 测试社群" };
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.credentials, "include");
    const url = new URL(input);
    requestedUrls.push(url);

    if (url.pathname.endsWith("/h5_feeds_detail")) {
      return jsonResponse({
        feedsDetail: {
          id: "feed-2",
          community_title: "测试社群",
          title: "列表页导出帖子",
          nick_name: "作者",
          created_at: "2026-08-12 11:00:00",
          tags: [],
          content: { text: "正文" },
          file_json: [],
        },
      });
    }
    if (url.pathname.endsWith("/get_comment_praise_list")) {
      return jsonResponse({
        comment_list: { total_count: 0, list: [] },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await collectPostFromPage({
      url: "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-2&app_id=app-2",
    });

    assert.equal(
      result.sourceUrl,
      "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-2&app_id=app-2",
    );
    assert.equal(result.post.title, "列表页导出帖子");
    assert.equal(result.comments.length, 0);

    const detailRequest = requestedUrls.find((url) => url.pathname.endsWith("/h5_feeds_detail"));
    assert.equal(detailRequest.searchParams.get("community_id"), "community-demo");
    assert.equal(detailRequest.searchParams.get("feeds_id"), "feed-2");
    assert.equal(detailRequest.searchParams.get("app_id"), "app-2");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});

function jsonResponse(data) {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("extracts the quoted question from QA answer posts", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;

  globalThis.location = new URL(
    "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-qa&app_id=app-1",
  );
  globalThis.document = { title: "概念与个股涨跌的相关性 - 测试社群" };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/h5_feeds_detail")) {
      return jsonResponse({
        feedsDetail: {
          id: "feed-qa",
          community_title: "测试社群",
          // 回答帖的 feed.title 常为空，标题应 fallback 到问题标题
          title: "",
          nick_name: "胡浩",
          role_name: "圈主",
          created_at: "2026-07-07 09:32:00",
          feeds_type: 10,
          is_answered: 1,
          tags: [],
          content: {
            text: "我其实没怎么关注这些……",
            question_title: "概念与个股涨跌的相关性",
            question_text: "海大，固态电池概念相对于科新机电……",
            questioner_info: { nick_name: "旭风" },
          },
          file_json: [],
        },
      });
    }
    if (url.pathname.endsWith("/get_comment_praise_list")) {
      return jsonResponse({ comment_list: { total_count: 0, list: [] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await collectPostFromPage();
    assert.equal(result.post.author, "胡浩");
    assert.equal(result.post.text, "我其实没怎么关注这些……");
    // feed.title 为空时，标题 fallback 到问题标题而非作者回答正文
    assert.equal(result.post.title, "概念与个股涨跌的相关性");
    assert.deepEqual(result.post.question, {
      asker: "旭风",
      title: "概念与个股涨跌的相关性",
      text: "海大，固态电池概念相对于科新机电……",
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});

test("extracts the quoted question from nested feed_info of QA answer posts", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;

  globalThis.location = new URL(
    "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-qa2&app_id=app-1",
  );
  globalThis.document = { title: "测试社群" };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/h5_feeds_detail")) {
      return jsonResponse({
        feedsDetail: {
          id: "feed-qa2",
          community_title: "测试社群",
          title: "关于估值的提问",
          nick_name: "胡浩",
          created_at: "2026-07-08 10:00:00",
          feeds_type: 10,
          is_answered: 1,
          tags: [],
          content: { text: "这是我的回答。" },
          feed_info: {
            id: "feed-qa2-q",
            content: {
              question_title: "关于估值的提问",
              question_text: "请问如何估值？",
              questioner_info: { nick_name: "李四" },
            },
          },
          file_json: [],
        },
      });
    }
    if (url.pathname.endsWith("/get_comment_praise_list")) {
      return jsonResponse({ comment_list: { total_count: 0, list: [] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await collectPostFromPage();
    assert.deepEqual(result.post.question, {
      asker: "李四",
      title: "关于估值的提问",
      text: "请问如何估值？",
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});

test("keeps plain posts without a quoted question unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;

  globalThis.location = new URL(
    "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-plain&app_id=app-1",
  );
  globalThis.document = { title: "测试社群" };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/h5_feeds_detail")) {
      return jsonResponse({
        feedsDetail: {
          id: "feed-plain",
          community_title: "测试社群",
          title: "普通帖子",
          nick_name: "作者",
          created_at: "2026-08-12 10:00:00",
          tags: [],
          content: { text: "普通正文" },
          file_json: [],
        },
      });
    }
    if (url.pathname.endsWith("/get_comment_praise_list")) {
      return jsonResponse({ comment_list: { total_count: 0, list: [] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await collectPostFromPage();
    assert.equal(result.post.question, null);
    assert.equal(result.post.text, "普通正文");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});

test("truncates long first lines used as post titles", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;

  globalThis.location = new URL(
    "https://quanzi.xiaoe-tech.com/community-demo/feed_detail?feeds_id=feed-long&app_id=app-1",
  );
  globalThis.document = { title: "测试社群" };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/h5_feeds_detail")) {
      return jsonResponse({
        feedsDetail: {
          id: "feed-long",
          community_title: "测试社群",
          title: "",
          nick_name: "作者",
          created_at: "2026-08-12 10:00:00",
          tags: [],
          content: {
            text: "这是一段非常长的正文第一行，作者洋洋洒洒写了很多内容，远远超出了适合作为标题展示的长度，需要被截断处理。",
          },
          file_json: [],
        },
      });
    }
    if (url.pathname.endsWith("/get_comment_praise_list")) {
      return jsonResponse({ comment_list: { total_count: 0, list: [] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await collectPostFromPage();
    // 正文第一行做标题时截断到 40 字符并加省略号
    assert.ok(result.post.title.endsWith("…"));
    assert.ok(Array.from(result.post.title).length <= 41);
    assert.ok(result.post.title.startsWith("这是一段非常长的正文第一行"));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    globalThis.document = originalDocument;
  }
});
