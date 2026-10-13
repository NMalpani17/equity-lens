import { LegalPage, LegalSection } from "./LegalPage";

/** Public privacy page, in plain language. Keep it in sync with what the app stores. */
export function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p>
        Equity Lens is a personal portfolio project. This page explains what it keeps
        about you and why.
      </p>

      <LegalSection title="What we collect">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Your email address</strong>, to sign you in. If you use Google, we
            also get the name and profile picture Google shares at sign-in.
          </li>
          <li>
            <strong>Your portfolio holdings</strong>: the tickers, share counts, buy
            prices and dates you enter.
          </li>
          <li>
            <strong>Your chat history</strong> with the AI analyst, and a count of how
            many questions and reports you use each day (for the daily limits).
          </li>
        </ul>
        <p>
          The demo uses a temporary account with no email. We don&apos;t use ads or
          tracking cookies.
        </p>
      </LegalSection>

      <LegalSection title="Where it's stored">
        <p>
          Your account and data are stored in Supabase (a hosted database and sign-in
          service). Daily backups are kept in Google Cloud Storage and deleted
          automatically after about three months.
        </p>
      </LegalSection>

      <LegalSection title="How it's used">
        <p>
          Only to run the app: to show your portfolio, answer your questions and enforce
          the daily limits. To answer a question, your message (and, when it needs it,
          your holdings) is sent to Google&apos;s Gemini AI. Stock tickers are sent to
          market-data providers to get prices. We keep diagnostic logs of AI answers to
          fix problems; they use a scrambled ID instead of your account, and your email
          and portfolio figures are removed from them.
        </p>
        <p>
          <strong>We never sell your data</strong> or share it for advertising.
        </p>
      </LegalSection>

      <LegalSection title="Deleting your account">
        <p>
          Go to <strong>Account settings → Delete account</strong>. This permanently
          deletes your holdings, chat history, usage counts and login. Copies in backups
          are deleted automatically within about three months.
        </p>
        <p>
          Diagnostic logs of AI answers (under a scrambled ID, without your email or
          portfolio figures) aren&apos;t deleted with your account and may be kept for
          as long as the tracing service stores them.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
