# ComfyUI-EVM-Group (Set/Get Container)

Container de grupo avançado para o **ComfyUI** com painéis laterais dedicados para `GetNode` (esquerda) e `SetNode` (direita), alinhamento automático na grade do ComfyUI, redimensionamento/reflow em tempo real e integração nativa com a **Selection Toolbox**.

---

## ✨ Principais Recursos

- **Painéis Laterais de `GetNode` e `SetNode`:**
  - Painel esquerdo dedicado para `GetNode` (entradas sem fio do grupo) e painel direito dedicado para `SetNode` (saídas sem fio do grupo).
  - Botões `+ Add GetNode` e `+ Add SetNode` integrados no cabeçalho de cada painel.
  - Botões `◀` / `▶` para ocultar ou exibir individualmente cada painel lateral (redirecionando visualmente os fios para o cabeçalho quando ocultos).
  - Nomenclatura automática `<NomeDoGrupo>_<TIPO>` ao conectar uma saída em um `SetNode` ancorado, sincronizando automaticamente os `GetNode` pareados quando o grupo é renomeado.
- **Alinhamento Canônico no Grid e Auto-Reflow em Tempo Real:**
  - Margens e espaçamentos configuráveis em múltiplos do grid do ComfyUI (`10px`), com padrão de **3 quadradinhos (`30px`)** de margem e espaçamento entre nós (respeitando a tag `#ID`/tempo de execução acima de cada nó).
  - Os painéis laterais e a área central redimensionam automaticamente para acomodar os nós maximizados ou minimizados (`collapse`).
  - Ao minimizar, maximizar ou redimensionar qualquer nó (horizontal ou verticalmente), os nós abaixo e a caixa do grupo se ajustam em tempo real para evitar sobreposições.
- **Sistema de Cores Padrão do ComfyUI:**
  - Usa a paleta oficial de grupos do ComfyUI (`LGraphCanvas.node_colors`), com seletor rápido de cores na barra de ações flutuante e no menu de contexto.
- **Multi-Seleção Completa:**
  - Seleção por retângulo de arraste (**Marquee**) em tempo real, `Shift + Clique` entre múltiplos grupos e nós em qualquer ordem, e `Ctrl + A`.
- **Tela de Configurações Nativa no ComfyUI (`⚡ EVM Group`):**
  - Configure margens, espaçamentos vertical/horizontal, abertura padrão dos painéis, formato de auto-naming, cores padrão, opacidades, tamanho da fonte e visibilidade de botões diretamente nas **Configurações do ComfyUI**.

---

## 📦 Requisitos

- **ComfyUI** (suporta tanto o Canvas clássico quanto o Nodes 2.0).
- Recomendado: **[ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)** (para fornecer os nós `SetNode` e `GetNode`).

---

## 🚀 Instalação

Clone este repositório dentro da pasta `ComfyUI/custom_nodes/`:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/eduvm/ComfyUI-EVM-Group.git
```

Reinicie o ComfyUI ou recarregue a página (`F5`).

---

## ⚙️ Configurações (`Settings` → `⚡ EVM Group`)

Abra as **Configurações do ComfyUI** (ícone de engrenagem) e acesse a aba **`⚡ EVM Group`**:

1. **Layout & Grade:**
   - Margem interna do grupo (em quadradinhos do grid, padrão `3` = `30px`).
   - Espaçamento vertical visível entre nós (em quadradinhos do grid, padrão `3` = `30px` visíveis / `60px` com título).
   - Espaçamento horizontal entre colunas (em quadradinhos do grid, padrão `3` = `30px`).
   - Auto-Reflow ao vivo ao redimensionar ou minimizar/maximizar nós (`Ativado` por padrão).
   - Snap automático na grade de `10px` (`Ativado` por padrão).
2. **Painéis SetNode & GetNode:**
   - Iniciar novos grupos com painel `GetNode` (esquerdo) aberto.
   - Iniciar novos grupos com painel `SetNode` (direito) aberto.
   - Formato de nomenclatura automática do `SetNode` (`<Grupo>_<TIPO>`, `<TIPO>_<Grupo>` ou `Desativado`).
   - Sincronizar nomes dos `SetNode`/`GetNode` ao renomear o título do grupo.
3. **Aparência & Cabeçalho:**
   - Cor padrão para novos grupos, tamanho da fonte do título, opacidade do título e do corpo, visibilidade dos botões do cabeçalho (`Sempre visíveis`, `Compacto`, `Apenas ao passar o mouse`) e exibição de fios quando recolhido (`Fold`).
4. **Barra de Ações (Toolbox):**
   - Exibir barra flutuante ao selecionar um grupo e exibir botão `EVM Group` na Selection Toolbox nativa do ComfyUI.
