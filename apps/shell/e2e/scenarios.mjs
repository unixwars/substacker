// Each scenario is a complete static site: the shell, a config.json and a content directory
// derived from the fixture feed.
export const scenarios = {
  // Everything on: actions, subscribe link.
  main: { shell: { feedName: "Example Newsletter", subscribeUrl: "https://example.substack.com/subscribe", actions: ["comment", "share"], utmSource: "substacker" }, hidden: [] },
  // No actions, no subscribe link, one hidden post.
  bare: { shell: { feedName: "Example Newsletter", actions: [], utmSource: "substacker" }, hidden: ["second-post"] },
  // A feed with no posts.
  empty: { shell: { feedName: "Example Newsletter", actions: [], utmSource: "substacker" }, hidden: [], noPosts: true },
};
