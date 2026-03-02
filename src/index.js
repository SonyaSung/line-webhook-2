const express = require("express");
const app = express();

app.use(express.json());

app.get("/health", (req, res) => res.send("ok"));
app.post("/line/webhook", (req, res) => {
console.log("LINE event:", JSON.stringify(req.body));
res.status(200).send("ok");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
