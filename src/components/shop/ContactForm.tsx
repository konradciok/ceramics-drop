'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';

export function ContactForm() {
  const t = useTranslations();
  const [sent, setSent] = useState(false);

  return (
    <form
      className={`contact-form${sent ? ' sent' : ''}`}
      id="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
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
        <p>{t('contact.sentP')}</p>
      </div>
    </form>
  );
}
