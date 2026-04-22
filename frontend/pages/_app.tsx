import { ClerkProvider } from "@clerk/nextjs";
import type { AppProps } from "next/app";
import Head from "next/head";
import "react-datepicker/dist/react-datepicker.css";
import "../styles/globals.css";

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ClerkProvider {...pageProps}>
      <Head>
        <title>Healthcare Consultation Assistant</title>
        <meta
          name="description"
          content="AI-powered medical consultation summaries"
        />
      </Head>
      <Component {...pageProps} />
    </ClerkProvider>
  );
}
