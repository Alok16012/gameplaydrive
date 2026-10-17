import { GET as matches } from "../../sports/matches/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const GET = () => matches();
