import { createRoot } from "react-dom/client";
import { SogViewer } from "../app/SogViewer";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(<SogViewer />);
