import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArchiveFilename,
  buildExportFilename,
  buildHtml,
  buildMarkdown,
  sanitizeFilename,
} from "../src/export-format.js";

const fixture = {
  exportedAt: "2026-08-12T10:00:00.000Z",
  sourceUrl: "https://quanzi.xiaoe-tech.com/community/feed_detail?feeds_id=1&app_id=2",
  community: { title: "里海的朋友们的社群" },
  post: {
    title: "请帮忙看下 <投资价值>",
    text: "正文第一行\n正文第二行",
    author: "作者",
    createdAt: "2026-08-10 12:21:50",
    displayTime: "",
    location: "云南",
    attachments: [{ name: "报告.pdf", url: "https://cdn/report.pdf", size: 1024 }],
  },
  comments: [
    {
      id: "1",
      author: "评论者",
      role: "圈主",
      text: "<script>alert(1)</script>",
      createdAt: "2026-08-10 21:49:29",
      displayTime: "",
      location: "浙江",
      resources: ["https://cdn/comment.jpg"],
      replies: [
        {
          id: "11",
          author: "李四",
          role: "",
          text: "直接回复一级评论",
          createdAt: "2026-08-10 22:00:00",
          displayTime: "",
          location: "",
          resources: [],
          replies: [],
          replyTo: "评论者",
          replyToId: "1",
          mainCommentId: "1",
        },
        {
          id: "12",
          author: "作者",
          role: "圈主",
          text: "回复李四的追问",
          createdAt: "2026-08-10 22:05:00",
          displayTime: "",
          location: "",
          resources: [],
          replies: [],
          replyTo: "李四",
          replyToId: "11",
          mainCommentId: "1",
        },
        {
          id: "13",
          author: "作者",
          role: "圈主",
          text: "回复已删除评论",
          createdAt: "2026-08-10 22:10:00",
          displayTime: "",
          location: "",
          resources: [],
          replies: [],
          replyTo: "王五",
          replyToId: "99",
          mainCommentId: "1",
          replyMissing: true,
        },
      ],
    },
  ],
};

test("sanitizes archive filenames", () => {
  assert.equal(sanitizeFilename('a/b:c*?"<d>|'), "a_b_c____d__");
});

test("uses the post creation time in archive filenames", () => {
  assert.equal(
    buildArchiveFilename(fixture),
    "请帮忙看下 _投资价值_-2026-08-10-12-21-50.zip",
  );
});

test("falls back to the export time when the post creation time is missing", () => {
  assert.equal(
    buildArchiveFilename({ ...fixture, post: { ...fixture.post, createdAt: "" } }),
    "请帮忙看下 _投资价值_-2026-08-12-10-00-00.zip",
  );
});

test("builds export filenames from post time, title head and author", () => {
  assert.equal(buildExportFilename(fixture, "md"), "2026-08-10_122150_请帮忙看下_作者.md");
  assert.equal(buildExportFilename(fixture, "html"), "2026-08-10_122150_请帮忙看下_作者.html");
  assert.equal(buildExportFilename(fixture, "zip"), "2026-08-10_122150_请帮忙看下_作者.zip");
});

test("prefers display time and pads single-digit parts in export filenames", () => {
  const data = {
    ...fixture,
    post: { ...fixture.post, createdAt: "", displayTime: "2026-8-9 7:5:3" },
  };
  assert.equal(buildExportFilename(data, "md"), "2026-08-09_070503_请帮忙看下_作者.md");
});

test("falls back to placeholders in export filenames", () => {
  const data = {
    exportedAt: "2026-08-12T10:00:00.000Z",
    post: { title: "", author: "", createdAt: "", displayTime: "" },
  };
  assert.equal(buildExportFilename(data, "md"), "2026-08-12_100000_帖子_匿名用户.md");
});

test("sanitizes illegal characters in export filename segments", () => {
  const data = {
    ...fixture,
    post: {
      ...fixture.post,
      title: "a/b:c*?\"<d>|一二三四五",
      author: "x\\y",
      createdAt: "2026-01-02 03:04:05",
    },
  };
  assert.equal(buildExportFilename(data, "md"), "2026-01-02_030405_a_b_c_x_y.md");
});

test("renders local attachment and media paths and escapes untrusted HTML", () => {
  const paths = new Map([
    ["https://cdn/report.pdf", "files/报告.pdf"],
    ["https://cdn/comment.jpg", "media/comments/1/图.jpg"],
  ]);
  const markdown = buildMarkdown(fixture, paths);
  const html = buildHtml(fixture, paths);

  assert.match(decodeURI(markdown), /files\/报告\.pdf/);
  assert.match(decodeURI(markdown), /media\/comments\/1\/图\.jpg/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renders reply-to context for replies of replies", () => {
  const markdown = buildMarkdown(fixture);
  const html = buildHtml(fixture);

  // 直接回复一级评论：不显示“回复 @”标注
  assert.doesNotMatch(markdown, /回复 \*\*@评论者\*\*/);
  assert.doesNotMatch(html, /回复 @评论者</);
  // 回复的回复：显示“回复 @被回复者”
  assert.match(markdown, /- \*\*作者 · 圈主\*\* 回复 \*\*@李四\*\* · 2026\\-08\\-10 22:05:00/);
  assert.match(html, /class="reply-to">回复 @李四</);
  // 被回复的评论缺失（如已删除）：附加提示
  assert.match(markdown, /回复 \*\*@王五\*\*（被回复的评论未能获取）/);
  assert.match(html, /class="reply-missing">（被回复的评论未能获取）</);
});

test("renders the quoted question block for QA answer posts", () => {
  const data = {
    ...fixture,
    post: {
      ...fixture.post,
      text: "我其实没怎么关注这些……",
      question: {
        asker: "旭风",
        title: "概念与个股涨跌的相关性",
        text: "海大，固态电池概念相对于科新机电……",
      },
    },
  };
  const markdown = buildMarkdown(data);
  const html = buildHtml(data);

  // Markdown：问题以引用块渲染在正文之前
  assert.match(markdown, /> \*\*旭风 提问：概念与个股涨跌的相关性\*\*/);
  assert.match(markdown, /> 海大，固态电池概念相对于科新机电……/);
  assert.match(markdown, /我其实没怎么关注这些……/);
  // HTML：问题块渲染在正文之前
  assert.match(html, /class="question-meta"><strong>旭风<\/strong> 提问：</);
  assert.match(html, /class="question-title">概念与个股涨跌的相关性</);
  assert.match(html, /class="question-text">海大，固态电池概念相对于科新机电……</);
  const questionPos = html.indexOf('class="question"');
  const contentPos = html.indexOf('class="content"');
  assert.ok(questionPos >= 0 && contentPos > questionPos);
});

test("omits the question block for plain posts", () => {
  const markdown = buildMarkdown(fixture);
  const html = buildHtml(fixture);
  assert.doesNotMatch(markdown, /提问：/);
  assert.doesNotMatch(html, /class="question"/);
});
