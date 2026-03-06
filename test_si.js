import si from 'systeminformation';

async function test() {
  const cpu = await si.cpu();
  const cpuLoad = await si.currentLoad();
  const net = await si.networkStats();
  console.log("Cores:", cpu.cores);
  console.log("CPUs array len:", cpuLoad.cpus.length);
  console.log("Net0:", net[0]);
}
test();
