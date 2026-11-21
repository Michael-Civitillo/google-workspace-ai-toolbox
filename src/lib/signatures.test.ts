/**
 * The signature template rules.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SIGNATURE_TEMPLATE,
  renderSignature,
  SIGNATURE_FIELDS,
  SIGNATURE_TEMPLATE_MAX,
  signatureToText,
  templateProblem,
  type SignatureProfile,
} from "./signatures";

const jane: SignatureProfile = {
  name: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  title: "Head of Sales",
  department: "Sales",
  phone: "+44 20 7946 0000",
};
const bare: SignatureProfile = { ...jane, title: "", department: "", phone: "" };

describe("templateProblem", () => {
  it("accepts the default template and every field", () => {
    assert.equal(templateProblem(DEFAULT_SIGNATURE_TEMPLATE), null);
    assert.equal(templateProblem(SIGNATURE_FIELDS.map((f) => `{{${f.key}}}`).join(" ")), null);
    assert.equal(templateProblem("{{ name }} | Example Ltd"), null);
  });

  it("refuses a misspelt field instead of writing it into every mailbox", () => {
    assert.match(templateProblem("{{name}}\n{{tittle}}") ?? "", /\{\{tittle\}\} isn't a field/);
    assert.match(templateProblem("{{Name}}") ?? "", /isn't a field/);
  });

  it("refuses braces that aren't a field", () => {
    for (const bad of ["{{first name}}", "{{name}", "name}}", "{{}}", "{{name.first}}"]) {
      assert.notEqual(templateProblem(bad), null, bad);
    }
  });

  it("refuses an empty, overlong or binary template", () => {
    assert.match(templateProblem("") ?? "", /empty/);
    assert.match(templateProblem("  \n ") ?? "", /empty/);
    assert.match(templateProblem("x".repeat(SIGNATURE_TEMPLATE_MAX + 1)) ?? "", /too long/);
    assert.match(templateProblem("a\u0000b") ?? "", /control characters/);
    assert.notEqual(templateProblem(42), null);
    assert.equal(templateProblem("line one\n\tline two\r\n"), null);
  });
});

describe("renderSignature", () => {
  it("fills the default template in from the profile", () => {
    const out = renderSignature(DEFAULT_SIGNATURE_TEMPLATE, jane);
    assert.equal(
      out.html,
      '<div dir="ltr"><b>Jane Doe</b><br>Head of Sales<br>Sales<br>+44 20 7946 0000<br>' +
        '<a href="mailto:jane@example.com">jane@example.com</a></div>'
    );
    assert.deepEqual(out.missing, []);
  });

  it("leaves out a line whose fields are all empty for this person", () => {
    const out = renderSignature("**{{name}}**\n{{title}}, {{department}}\nTel: {{phone}}\n{{email}}", bare);
    assert.equal(
      out.html,
      '<div dir="ltr"><b>Jane Doe</b><br><a href="mailto:jane@example.com">jane@example.com</a></div>'
    );
    assert.deepEqual(out.missing.sort(), ["department", "phone", "title"]);
  });

  it("keeps a line that still has something to say", () => {
    const out = renderSignature("{{title}} {{name}}", bare);
    assert.equal(out.html, '<div dir="ltr">Jane Doe</div>');
    assert.deepEqual(out.missing, ["title"]);
  });

  it("always keeps a line with no fields", () => {
    const out = renderSignature("{{phone}}\nExample Ltd, 1 High Street", bare);
    assert.equal(out.html, '<div dir="ltr">Example Ltd, 1 High Street</div>');
  });

  it("doesn't leave a hole where a line was dropped", () => {
    const out = renderSignature("\n{{name}}\n\n{{phone}}\n\nExample Ltd\n\n\n", bare);
    assert.equal(out.html, '<div dir="ltr">Jane Doe<br><br>Example Ltd</div>');
  });

  it("escapes whatever the directory holds", () => {
    const evil: SignatureProfile = {
      ...jane,
      name: '<script>alert(1)</script>',
      title: 'CEO" onmouseover="x',
      department: "R&D <b>",
    };
    const { html } = renderSignature("{{name}}\n{{title}}\n{{department}}", evil);
    assert.equal(
      html,
      '<div dir="ltr">&lt;script&gt;alert(1)&lt;/script&gt;<br>CEO&quot; onmouseover=&quot;x<br>R&amp;D &lt;b&gt;</div>'
    );
  });

  it("escapes whatever the template holds, too", () => {
    const { html } = renderSignature('<img src=x onerror=alert(1)> {{name}}', jane);
    assert.equal(html, '<div dir="ltr">&lt;img src=x onerror=alert(1)&gt; Jane Doe</div>');
  });

  it("only ever links http(s) and email addresses", () => {
    const { html, lines } = renderSignature(
      "javascript:alert(1) data:text/html,x https://example.com/a?b=1&c=2. Mail sales@example.com!",
      jane
    );
    assert.equal(
      html,
      '<div dir="ltr">javascript:alert(1) data:text/html,x ' +
        '<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>. Mail ' +
        '<a href="mailto:sales@example.com">sales@example.com</a>!</div>'
    );
    const hrefs = lines.flat().map((p) => p.href).filter(Boolean);
    assert.deepEqual(hrefs, ["https://example.com/a?b=1&c=2", "mailto:sales@example.com"]);
  });

  it("a profile value can't smuggle in a link target or a second line", () => {
    const sly: SignatureProfile = { ...jane, title: 'x"><a href="javascript:alert(1)">y', phone: "1\n2\r\n3" };
    const { html } = renderSignature("{{title}}\n{{phone}}", sly);
    assert.ok(!/<a href="javascript/.test(html));
    assert.equal((html.match(/<br>/g) ?? []).length, 1);
    assert.ok(html.includes("1 2 3"));
  });

  it("bolds what is between ** and **, including a linked address", () => {
    const { html } = renderSignature("**{{name}}** | **{{email}}** | 2 ** 3", jane);
    assert.equal(
      html,
      '<div dir="ltr"><b>Jane Doe</b> | <b><a href="mailto:jane@example.com">jane@example.com</a></b> | 2 ** 3</div>'
    );
  });

  it("gives the same thing as data, for drawing without HTML", () => {
    const { lines } = renderSignature("**{{name}}**\n{{email}}", jane);
    assert.deepEqual(lines, [
      [{ text: "Jane Doe", bold: true }],
      [{ text: "jane@example.com", href: "mailto:jane@example.com" }],
    ]);
  });

  it("renders nothing at all when every line drops out", () => {
    assert.deepEqual(renderSignature("{{phone}}\n{{title}}", bare), {
      html: "",
      lines: [],
      missing: ["phone", "title"],
    });
  });
});

describe("signatureToText", () => {
  it("turns someone's existing signature into plain lines", () => {
    assert.equal(
      signatureToText('<div dir="ltr"><b>Jane</b><br>R&amp;D &lt;lab&gt;</div><div>Tel:&nbsp;123</div>'),
      "Jane\nR&D <lab>\nTel: 123"
    );
  });

  it("drops markup rather than keeping any of it", () => {
    const text = signatureToText('<img src=x onerror="alert(1)"><a href="javascript:x">click</a><script>bad()</script>');
    assert.ok(!text.includes("<"));
    assert.ok(text.includes("click"));
  });

  it("is empty for no signature", () => {
    assert.equal(signatureToText(""), "");
    assert.equal(signatureToText(null), "");
    assert.equal(signatureToText("<div><br></div>"), "");
  });
});
