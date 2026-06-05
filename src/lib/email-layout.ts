/**
 * Shared Resend template shell (table layout, brand tokens). The {{{MAIN_CONTENT}}}
 * placeholder is filled at send time with escaped, localised body HTML.
 */
export const RESEND_TEMPLATE_ALIASES = {
  labelStudio: 'label-to-studio',
  shippingConfirmation: 'shipping-confirmation',
  returnLabel: 'return-label-customer',
} as const;

/** Inner email styles — inline only, no shorthand (Resend template requirements). */
const BODY_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3A2818;';
const MUTED_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:rgba(58,40,24,0.75);';
const LABEL_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(58,40,24,0.55);';

/** Resend-published template HTML — keep in sync with dashboard templates. */
export function resendTemplateHtml(): string {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Anna Ciok Ceramics</title>
</head>
<body style="margin:0;padding:0;background-color:#FAF6EC;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FAF6EC" style="background-color:#FAF6EC;">
    <tr>
      <td align="center" style="padding-top:48px;padding-right:16px;padding-bottom:48px;padding-left:16px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <img src="https://anna-ciok.studio/logotype.png" alt="Anna Ciok Ceramics" width="48" height="48" border="0" style="display:block;" />
            </td>
          </tr>
          <tr>
            <td bgcolor="#FAF6EC" style="background-color:#FAF6EC;border-top-width:1px;border-top-style:solid;border-top-color:rgba(58,40,24,0.08);border-right-width:1px;border-right-style:solid;border-right-color:rgba(58,40,24,0.08);border-bottom-width:1px;border-bottom-style:solid;border-bottom-color:rgba(58,40,24,0.08);border-left-width:1px;border-left-style:solid;border-left-color:rgba(58,40,24,0.08);">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-top:40px;padding-right:40px;padding-bottom:40px;padding-left:40px;${BODY_STYLE}">
                    {{{MAIN_CONTENT}}}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(58,40,24,0.55);">
              Anna Ciok Ceramics · anna-ciok.studio
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Paragraph wrapper for template body fragments. */
export function emailParagraph(html: string): string {
  return `<p style="margin-top:0;margin-bottom:16px;${BODY_STYLE}">${html}</p>`;
}

/** Muted secondary paragraph. */
export function emailMutedParagraph(html: string): string {
  return `<p style="margin-top:0;margin-bottom:16px;${MUTED_STYLE}">${html}</p>`;
}

/** Uppercase label above a detail block. */
export function emailFieldLabel(text: string): string {
  return `<p style="margin-top:0;margin-bottom:4px;${LABEL_STYLE}">${text}</p>`;
}

/** CTA button (table-based, Outlook-safe). */
export function emailButton(href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;margin-bottom:16px;">
  <tr>
    <td bgcolor="#9C5A2C" style="background-color:#9C5A2C;">
      <a href="${href}" style="display:inline-block;padding-top:14px;padding-bottom:14px;padding-left:28px;padding-right:28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:16px;letter-spacing:0.14em;text-transform:uppercase;color:#FAF6EC;text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;
}

/** Order summary table for studio label emails. */
export function emailDetailTable(rows: Array<{ label: string; value: string }>): string {
  const cells = rows
    .map(
      (row) => `<tr>
  <td style="padding-top:8px;padding-bottom:8px;padding-right:16px;vertical-align:top;${LABEL_STYLE}">${row.label}</td>
  <td style="padding-top:8px;padding-bottom:8px;vertical-align:top;${BODY_STYLE}">${row.value}</td>
</tr>`,
    )
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;margin-bottom:16px;">${cells}</table>`;
}
