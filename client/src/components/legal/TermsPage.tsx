import { Link } from "react-router-dom";

import { LegalPage, LegalSection } from "./LegalPage";

/** Public terms page, in plain language. */
export function TermsPage() {
  return (
    <LegalPage title="Terms">
      <LegalSection title="A personal project">
        <p>
          Equity Lens is a personal portfolio project, not a commercial service. It may
          change, have downtime, or be shut down at any time, and demo data may be
          reset.
        </p>
      </LegalSection>

      <LegalSection title="Not financial advice">
        <p>
          Nothing in Equity Lens is financial, investment, tax or legal advice. AI
          answers and reports can be wrong or out of date, so check the cited sources
          and make your own decisions.
        </p>
      </LegalSection>

      <LegalSection title="Provided as is">
        <p>
          The app is provided &quot;as is&quot;, without warranties of any kind. You use
          it at your own risk, and the author isn&apos;t liable for any loss that comes
          from using it.
        </p>
      </LegalSection>

      <LegalSection title="Your data">
        <p>
          What we store and how to delete it is described in the{" "}
          <Link
            to="/privacy"
            className="rounded-sm font-medium underline underline-offset-4 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Privacy
          </Link>{" "}
          page.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
