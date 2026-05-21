import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

registerLinkCoverage({ appName: "Plane (PM)", baseUrl: APP_URLS.PM });
