'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';
import { buildContactMailto } from '@/lib/contact-mailto';
import { EMAIL } from '@/lib/email-addresses';

export function ContactForm() {
  const t = useTranslations();
  const [sent, setSent] = useState(false);
  const [mailtoUrl, setMailtoUrl] = useState(`mailto:${EMAIL.contact}`);

  return (
    <form
      className={`contact-form${sent ? ' sent' : ''}`}
      id="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        const name = String(formData.get('name') ?? '');
        const email = String(formData.get('email') ?? '');
        const topic = String(formData.get('topic') ?? '');
        const message = String(formData.get('message') ?? '');
        // "Compose opened", not "message delivered" — delivery happens in the
        // visitor's own mail client and is never confirmed here.
        pushDataLayer(buildEngagementEvent('contact_form_mailto_open', { topic }));
        // No server-side inbox: hand the message off to the visitor's own mail
        // client, pre-addressed to the studio, so it actually reaches Anna.
        const url = buildContactMailto({
          to: EMAIL.contact,
          subject: t('contact.mailtoSubject', { topic }),
          message,
          signature: `\n\n— ${name}${email ? ` (${email})` : ''}`,
          truncatedNote: t('contact.mailtoTruncated'),
        });
        setMailtoUrl(url);
        window.location.href = url;
        setSent(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    >
      <div className="form-fields">
        <div className="field">
          <label htmlFor="cf-name">{t('contact.fName')}</label>
          <input
            type="text"
            id="cf-name"
            name="name"
            placeholder={t('contact.fNamePh')}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="cf-email">{t('contact.fEmail')}</label>
          <input
            type="email"
            id="cf-email"
            name="email"
            placeholder={t('contact.fEmailPh')}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="cf-topic">{t('contact.fTopic')}</label>
          <select id="cf-topic" name="topic">
            <option>{t('contact.topic1')}</option>
            <option>{t('contact.topic2')}</option>
            <option>{t('contact.topic3')}</option>
            <option>{t('contact.topic4')}</option>
            <option>{t('contact.topic5')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cf-msg">{t('contact.fMsg')}</label>
          <textarea
            id="cf-msg"
            name="message"
            placeholder={t('contact.fMsgPh')}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary">
          <span>{t('contact.submit')}</span>{' '}
          <Icon name="arrow" className="btn-arrow" />
        </button>
        <p className="form-note">{t.rich('contact.note', richTags)}</p>
      </div>

      <div className="form-sent">
        <div className="seal">
          <Icon name="check" />
        </div>
        <h3>{t.rich('contact.sentH', richTags)}</h3>
        <p>
          {t.rich('contact.sentP', {
            ...richTags,
            link: (c) => (
              <a className="inline" href={mailtoUrl}>
                {c}
              </a>
            ),
          })}
        </p>
      </div>
    </form>
  );
}
