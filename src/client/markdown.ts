import MarkdownIt from "markdown-it";
import { full as emoji } from "markdown-it-emoji";

// Raw HTML is off, so message text can't inject markup. Images are off so a
// pasted image link can't make everyone's browser ping a third-party server.
// Setext headings are off because "text\n---" is too easy to hit by accident.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});
md.disable(["image", "lheading"]);
// :fire: style codes only; emoticons like :) stay as typed.
md.use(emoji, { shortcuts: {} });

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet("target", "_blank");
  tokens[i].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, i, opts, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}
