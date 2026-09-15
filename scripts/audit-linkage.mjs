import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

// Read-only audit against CLI JSON snapshots. Never needs credentials.
const dir = process.argv[2] ?? ".aa-handoff-tmp";
const environment = process.argv[3] ?? "prod";
const read = name => JSON.parse(fs.readFileSync(path.join(dir, environment + "_" + name + ".json"), "utf8")).rows;
const columns = new Map();
for (const row of read("columns")) {
  if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
  columns.get(row.table_name).add(row.column_name);
}
const functions = read("rpcs");
const inventory = [], issues = [], unresolved = [];
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir,e.name)] : []);
}
for (const file of ["src","agent-runtime/src","aa-mcp-gateway/src"].flatMap(files)) {
  const source = ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const vars = new Map();
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) vars.set(node.name.text,node.initializer);
    ts.forEachChild(node,collect);
  };
  collect(source);
  const literal = (node,seen=new Set()) => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a=literal(node.left,new Set(seen)),b=literal(node.right,new Set(seen));
      if(a!==undefined && b!==undefined)return a+b;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {seen.add(node.text);return literal(vars.get(node.text),seen);}
  };
  const line = node => source.getLineAndCharacterOfPosition(node.getStart()).line+1;
  function root(node) {
    if (!node) return undefined;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text==="from" && !node.expression.expression.getText(source).includes("storage")) return literal(node.arguments[0]);
      return root(node.expression.expression);
    }
  }
  function checkSelect(table,select,at) {
    let depth=0,part="",parts=[];
    for (const c of select+",") {
      if (c==="(") depth++;
      if (c===")") depth--;
      if(c==="," && depth===0){parts.push(part.trim());part="";}else part+=c;
    }
    for(const p of parts) {
      if(!p || p==="*")continue;
      const join=p.match(/^([^()]+)\((.*)\)$/s);
      if(join) {
        const target=join[1].split(":").at(-1).split("!")[0];
        if(columns.has(target))checkSelect(target,join[2],at);
        else unresolved.push({file,line:at,table,select:p,reason:"relationship requires FK resolution"});
      } else {
        const col=p.split(":").at(-1).split(/->|::/)[0].trim();
        if(!columns.get(table)?.has(col))issues.push({file,line:at,table,column:col});
      }
    }
  }
  function visit(node) {
    if(ts.isPropertyAssignment(node) && node.name.getText(source)==="rpc" && literal(node.initializer)) {
      const name=literal(node.initializer);
      inventory.push({file,line:line(node),kind:"route RPC",name});
      if(!functions.some(f=>f.proname===name))issues.push({file,line:line(node),rpc:name,reason:"missing route RPC"});
    }
    if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method=node.expression.name.text, name=literal(node.arguments[0]), table=root(node);
      if(method==="from" && table) {
        inventory.push({file,line:line(node),kind:"table",name:table,purpose:path.basename(file).replace(/\.tsx?$/,"")});
        if(!columns.has(table))issues.push({file,line:line(node),table,reason:"missing relation"});
      }
      if(method==="select" && table) {
        inventory.push({file,line:line(node),kind:"select",name:table,columns:name??node.arguments[0]?.getText(source)??"*"});
        if(name)checkSelect(table,name,line(node));else unresolved.push({file,line:line(node),table,reason:"dynamic select"});
      }
      if(table && ["eq","neq","gt","gte","lt","lte","is","in","order","contains","overlaps","not"].includes(method) && name && !name.includes(".")) {
        inventory.push({file,line:line(node),kind:method,name:table,columns:name});
        if(!columns.get(table)?.has(name))issues.push({file,line:line(node),table,column:name,reason:"missing filter column"});
      }
      if(table && ["insert","update","upsert"].includes(method) && ts.isObjectLiteralExpression(node.arguments[0])) {
        const names=node.arguments[0].properties.map(p=>p.name?.getText(source)).filter(Boolean);
        inventory.push({file,line:line(node),kind:method,name:table,columns:names.join(", ")});
        for(const name of names)if(!columns.get(table)?.has(name))issues.push({file,line:line(node),table,column:name,reason:"missing write column"});
      }
      if(method==="rpc") {
        const args=node.arguments[1];
        const names=args && ts.isObjectLiteralExpression(args) ? args.properties.map(p=>p.name?.getText(source)).filter(Boolean) : null;
        inventory.push({file,line:line(node),kind:"rpc",name:name??node.arguments[0].getText(source),args:names??args?.getText(source)});
        if(name) {
          const candidates=functions.filter(f=>f.proname===name);
          if(!candidates.length)issues.push({file,line:line(node),rpc:name,reason:"missing function"});
          else if(names && !candidates.some(f=>names.every(a=>f.proargnames?.includes(a))))issues.push({file,line:line(node),rpc:name,args:names,reason:"unknown arguments"});
        }else unresolved.push({file,line:line(node),reason:"dynamic RPC",expression:node.arguments[0].getText(source)});
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
const report={environment,inventory,issues,unresolved};
fs.writeFileSync(path.join(dir,environment+"_linkage.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({environment,entries:inventory.length,issues,unresolved},null,2));
process.exitCode=issues.length?1:0;
